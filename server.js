const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve frontend static assets from public/ directory
app.use(express.static(path.join(__dirname, 'public')));

// Standard browser User-Agent to prevent getting blocked by Letterboxd
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Helper to fetch html using native curl command (bypasses Cloudflare JA3 TLS fingerprint blocks)
function fetchHtmlViaCurl(url) {
  return new Promise((resolve, reject) => {
    const escapedUrl = url.replace(/"/g, '\\"');
    const cmd = `curl -s -L -A "${USER_AGENT}" "${escapedUrl}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Helper to fetch and parse a single page of a Letterboxd list
async function fetchPageFilms(url) {
  try {
    const html = await fetchHtmlViaCurl(url);
    const $ = cheerio.load(html);
    const films = [];

    // Letterboxd lists represent films inside divs with data-item-slug attribute
    $('[data-item-slug]').each((i, el) => {
      const slug = $(el).attr('data-item-slug');
      const title = $(el).attr('data-item-name') || $(el).find('img').attr('alt') || 'Unknown Film';
      
      if (slug) {
        films.push({
          title,
          slug
        });
      }
    });

    return films;
  } catch (error) {
    console.error(`Error scraping page ${url}:`, error.message);
    return [];
  }
}

// Helper to extract maximum pagination page count from initial HTML load
function parseMaxPages($) {
  let maxPage = 1;
  $('.paginate-pages a').each((i, el) => {
    const pageText = $(el).text().trim();
    const pageNum = parseInt(pageText, 10);
    if (!isNaN(pageNum) && pageNum > maxPage) {
      maxPage = pageNum;
    }
  });
  return maxPage;
}

// Helper to fetch and parse a user's watched film history (up to 25 pages / 1800 films)
async function fetchUserWatchedFilms(username) {
  const watchedSlugs = new Set();
  const maxPagesToCheck = 25; // Safe maximum page check limit (1800 movies)

  try {
    const profileUrl = `https://letterboxd.com/${username}/films/`;
    console.log(`Scraping watched history for user ${username} from: ${profileUrl}`);
    
    const html = await fetchHtmlViaCurl(profileUrl);
    const $ = cheerio.load(html);
    
    // Parse watched films on page 1
    $('[data-item-slug]').each((i, el) => {
      const slug = $(el).attr('data-item-slug');
      if (slug) watchedSlugs.add(slug);
    });

    const maxPages = parseMaxPages($);
    if (maxPages > 1) {
      const pagesToFetch = Math.min(maxPages, maxPagesToCheck);
      console.log(`User ${username} has multiple watched films pages (${maxPages}). Scraping up to page ${pagesToFetch} sequentially...`);
      
      for (let p = 2; p <= pagesToFetch; p++) {
        const nextPageUrl = `https://letterboxd.com/${username}/films/page/${p}/`;
        try {
          await new Promise(resolve => setTimeout(resolve, 150)); // Sleep 150ms to be polite
          const pageHtml = await fetchHtmlViaCurl(nextPageUrl);
          const $next = cheerio.load(pageHtml);
          let foundCount = 0;
          $next('[data-item-slug]').each((i, el) => {
            const slug = $next(el).attr('data-item-slug');
            if (slug) {
              watchedSlugs.add(slug);
              foundCount++;
            }
          });
          if (foundCount === 0) break; // Stop early if page is empty
        } catch (e) {
          console.error(`Error fetching watched page ${p} for ${username}:`, e.message);
        }
      }
    }

    console.log(`Successfully retrieved ${watchedSlugs.size} watched films for user ${username}`);
    return watchedSlugs;
  } catch (error) {
    console.error(`Failed to scrape watched history for ${username}:`, error.message);
    return watchedSlugs; // Return whatever was retrieved (or empty)
  }
}

/**
 * POST /api/list
 * Payload: { url: string, username?: string, skipWatched?: boolean }
 * Returns list of movies scraped from the Letterboxd list page
 */
app.post('/api/list', async (req, res) => {
  let { url, username, skipWatched } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'Letterboxd list URL is required.' });
  }

  // Ensure URL is absolute and correctly formatted
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }

  try {
    console.log(`Scraping Letterboxd list: ${url}`);
    
    // Fetch page 1
    const html = await fetchHtmlViaCurl(url);
    const $ = cheerio.load(html);
    
    // Parse list items from page 1
    const page1Films = [];
    $('[data-item-slug]').each((i, el) => {
      const slug = $(el).attr('data-item-slug');
      const title = $(el).attr('data-item-name') || $(el).find('img').attr('alt') || 'Unknown Film';
      
      if (slug) {
        page1Films.push({ title, slug });
      }
    });

    // Detect if there are multiple pages
    const maxPages = parseMaxPages($);
    let allFilms = [...page1Films];

    if (maxPages > 1) {
      console.log(`Detected multiple pages. Total pages: ${maxPages}. Fetching up to 10 pages sequentially...`);
      
      // Clean base URL to remove any trailing slashes or existing page segments
      let cleanBaseUrl = url.replace(/\/$/, '').replace(/\/page\/\d+/, '');
      const pageLimit = Math.min(maxPages, 10);
      
      for (let p = 2; p <= pageLimit; p++) {
        const nextPageUrl = `${cleanBaseUrl}/page/${p}/`;
        try {
          await new Promise(resolve => setTimeout(resolve, 150)); // Sleep 150ms to be polite
          const pageFilms = await fetchPageFilms(nextPageUrl);
          if (pageFilms.length === 0) break;
          allFilms.push(...pageFilms);
        } catch (e) {
          console.error(`Error fetching list page ${p}:`, e.message);
          break;
        }
      }
    }

    if (allFilms.length === 0) {
      return res.status(404).json({ error: 'No films found. Please ensure the list is public and contains films.' });
    }

    const totalBeforeFiltering = allFilms.length;
    let skippedCount = 0;

    // Filter watched films if skipWatched option is enabled
    if (skipWatched && username && username.trim() !== '') {
      const cleanedUsername = username.trim().toLowerCase();
      const watchedSlugs = await fetchUserWatchedFilms(cleanedUsername);
      
      if (watchedSlugs.size > 0) {
        allFilms = allFilms.filter(film => !watchedSlugs.has(film.slug));
        skippedCount = totalBeforeFiltering - allFilms.length;
      }
    }

    if (allFilms.length === 0) {
      return res.status(400).json({ 
        error: `Nothing found! You've already watched all ${totalBeforeFiltering} films in this list (User: ${username}).` 
      });
    }

    res.json({
      films: allFilms,
      count: allFilms.length,
      totalPages: maxPages,
      totalBeforeFiltering,
      skippedCount
    });

  } catch (error) {
    console.error(`Error processing list URL ${url}:`, error.message);
    res.status(500).json({ error: `Failed to scrape Letterboxd list: ${error.message}` });
  }
});

/**
 * GET /api/movie-details
 * Query: ?slug=movie-slug
 * Scrapes detailed information for a single movie
 */
app.get('/api/movie-details', async (req, res) => {
  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ error: 'Film slug is required.' });
  }

  const movieUrl = `https://letterboxd.com/film/${slug}/`;

  try {
    console.log(`Scraping movie details for: ${slug}`);
    const html = await fetchHtmlViaCurl(movieUrl);
    const $ = cheerio.load(html);

    let details = {
      title: '',
      year: '',
      directors: [],
      description: '',
      image: '',
      link: movieUrl
    };

    // Attempt to parse JSON-LD script for clean schema.org metadata
    const jsonLdScript = $('script[type="application/ld+json"]').html();
    
    if (jsonLdScript) {
      try {
        // Strip CDATA comments from the JSON-LD script content
        const cleanedJson = jsonLdScript.replace(/\/\*[\s\S]*?\*\//g, '').trim();
        const parsed = JSON.parse(cleanedJson);
        const movie = Array.isArray(parsed) ? parsed.find(item => item['@type'] === 'Movie') : parsed;
        
        if (movie && movie['@type'] === 'Movie') {
          details.title = movie.name;
          details.image = movie.image || '';
          details.description = movie.description || '';
          
          if (movie.director) {
            const directorsArr = Array.isArray(movie.director) ? movie.director : [movie.director];
            details.directors = directorsArr.map(d => d.name).filter(Boolean);
          }
          
          if (movie.releasedEvent) {
            const release = Array.isArray(movie.releasedEvent) ? movie.releasedEvent[0] : movie.releasedEvent;
            if (release && release.startDate) {
              details.year = new Date(release.startDate).getFullYear().toString();
            }
          } else if (movie.dateCreated) {
            details.year = new Date(movie.dateCreated).getFullYear().toString();
          }
        }
      } catch (e) {
        console.error('Error parsing JSON-LD script tag:', e.message);
      }
    }

    // Fallbacks if JSON-LD is missing or partially parsed
    if (!details.title) {
      const ogTitle = $('meta[property="og:title"]').attr('content');
      if (ogTitle) {
        const match = ogTitle.match(/^(.*)\s+\((\d{4})\)$/);
        if (match) {
          details.title = match[1];
          details.year = match[2];
        } else {
          details.title = ogTitle;
        }
      } else {
        details.title = $('.headline-1, .film-title, h1').first().text().trim() || slug;
      }
    }
    
    if (!details.year) {
      details.year = $('.releaseyear, .releaseyear a').first().text().trim();
    }
    
    if (details.directors.length === 0) {
      const parsedDirs = [];
      $('span.director a, a[href^="/director/"]').each((i, el) => {
        parsedDirs.push($(el).text().trim());
      });
      details.directors = [...new Set(parsedDirs)];
    }

    if (!details.description) {
      // Scrape storyline synopsis
      details.description = $('.film-synopsis .truncate, .film-synopsis, .storyline .truncate').first().text().trim();
      // Remove any trailing "read more" text from truncate toggles
      details.description = details.description.replace(/\s*…\s*more\s*$/i, '');
    }

    if (!details.image) {
      details.image = $('.image-container img, .poster img').first().attr('src') || '';
    }

    res.json(details);

  } catch (error) {
    console.error(`Error scraping movie page for slug ${slug}:`, error.message);
    res.status(500).json({ error: `Failed to scrape movie details: ${error.message}` });
  }
});

// Start Express server when run directly (local dev AND Render/production)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Letterboxd Roulette server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
