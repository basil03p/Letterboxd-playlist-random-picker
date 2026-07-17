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
      const fullName = $(el).attr('data-item-name') || $(el).find('img').attr('alt') || 'Unknown Film';
      
      if (slug) {
        // Extract year from title like "Animal Factory (2000)"
        const yearMatch = fullName.match(/\((\d{4})\)\s*$/);
        const year = yearMatch ? yearMatch[1] : null;
        const title = yearMatch ? fullName.replace(/\s*\(\d{4}\)\s*$/, '').trim() : fullName;
        
        films.push({ title, slug, year });
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
    // Strip genre/decade filter segments from URL before scraping
    // Letterboxd blocks these filtered URLs for server-side scrapers (Cloudflare)
    // Filtering is applied client-side using year data embedded in film titles
    const urlObj = new URL(url);
    let cleanPath = urlObj.pathname
      .replace(/\/genre\/[^/]+/g, '')
      .replace(/\/decade\/[^/]+/g, '')
      .replace(/\/page\/\d+/g, '')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '') + '/';
    const baseUrl = urlObj.origin + cleanPath;
    
    console.log(`Scraping Letterboxd list: ${baseUrl}`);
    
    // Fetch page 1
    const html = await fetchHtmlViaCurl(baseUrl);
    const $ = cheerio.load(html);
    
    // Parse list items from page 1
    const page1Films = [];
    $('[data-item-slug]').each((i, el) => {
      const slug = $(el).attr('data-item-slug');
      const fullName = $(el).attr('data-item-name') || $(el).find('img').attr('alt') || 'Unknown Film';
      
      if (slug) {
        const yearMatch = fullName.match(/\((\d{4})\)\s*$/);
        const year = yearMatch ? yearMatch[1] : null;
        const title = yearMatch ? fullName.replace(/\s*\(\d{4}\)\s*$/, '').trim() : fullName;
        page1Films.push({ title, slug, year });
      }
    });

    // Detect if there are multiple pages
    const maxPages = parseMaxPages($);
    let allFilms = [...page1Films];

    if (maxPages > 1) {
      console.log(`Detected multiple pages. Total pages: ${maxPages}. Fetching up to 10 pages sequentially...`);
      
      // Use cleaned base URL (no genre/decade/page segments) for pagination
      const pageLimit = Math.min(maxPages, 10);
      const cleanBase = baseUrl.replace(/\/$/, '');
      
      for (let p = 2; p <= pageLimit; p++) {
        const nextPageUrl = `${cleanBase}/page/${p}/`;
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
 * Scrapes comprehensive information for a single movie from Letterboxd.
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

    // Helper: parse ISO 8601 duration string (e.g. "PT2H27M") to "2h 27m"
    function parseDuration(iso) {
      if (!iso) return '';
      const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
      if (!match) return '';
      const h = parseInt(match[1] || '0', 10);
      const m = parseInt(match[2] || '0', 10);
      if (h && m) return `${h}h ${m}m`;
      if (h) return `${h}h`;
      if (m) return `${m}m`;
      return '';
    }

    let details = {
      title: '',
      year: '',
      directors: [],
      cast: [],                // top billed actors
      description: '',
      image: '',               // poster
      genres: [],
      runtime: '',             // e.g. "2h 27m"
      rating: null,            // e.g. 4.09
      ratingCount: null,       // e.g. 1188528
      studios: [],             // production companies
      countries: [],
      languages: [],
      originalTitle: '',
      link: movieUrl
    };

    // ── Primary: parse JSON-LD schema.org block ───────────────────────────
    const jsonLdScript = $('script[type="application/ld+json"]').html();
    if (jsonLdScript) {
      try {
        // Strip CDATA wrapper and parse
        const cleanedJson = jsonLdScript.replace(/\/\*[\s\S]*?\*\//g, '').trim();
        const parsed = JSON.parse(cleanedJson);
        const movie = Array.isArray(parsed)
          ? parsed.find(item => item['@type'] === 'Movie')
          : parsed;

        if (movie && movie['@type'] === 'Movie') {
          details.title       = movie.name || '';
          details.image       = movie.image || '';
          details.description = movie.description || '';
          details.runtime     = parseDuration(movie.duration);
          details.genres      = Array.isArray(movie.genre) ? movie.genre : (movie.genre ? [movie.genre] : []);

          // Directors
          if (movie.director) {
            const dirs = Array.isArray(movie.director) ? movie.director : [movie.director];
            details.directors = dirs.map(d => d.name).filter(Boolean);
          }

          // Cast (actors) — first 10 billed
          if (movie.actor) {
            const actors = Array.isArray(movie.actor) ? movie.actor : [movie.actor];
            details.cast = actors.slice(0, 10).map(a => a.name).filter(Boolean);
          }

          // Production companies / studios
          if (movie.productionCompany) {
            const companies = Array.isArray(movie.productionCompany) ? movie.productionCompany : [movie.productionCompany];
            details.studios = companies.map(c => c.name).filter(Boolean);
          }

          // Countries
          if (movie.countryOfOrigin) {
            const countries = Array.isArray(movie.countryOfOrigin) ? movie.countryOfOrigin : [movie.countryOfOrigin];
            details.countries = countries.map(c => c.name).filter(Boolean);
          }

          // Languages (ISO codes like "de", "en" → use as-is, or map if needed)
          if (movie.inLanguage) {
            details.languages = Array.isArray(movie.inLanguage) ? movie.inLanguage : [movie.inLanguage];
          }

          // Aggregate rating
          if (movie.aggregateRating) {
            details.rating      = movie.aggregateRating.ratingValue ?? null;
            details.ratingCount = movie.aggregateRating.ratingCount ?? null;
          }

          // Year from dateCreated or releasedEvent
          if (movie.dateCreated) {
            details.year = new Date(movie.dateCreated).getFullYear().toString();
          } else if (movie.releasedEvent) {
            const release = Array.isArray(movie.releasedEvent) ? movie.releasedEvent[0] : movie.releasedEvent;
            if (release?.startDate) {
              details.year = new Date(release.startDate).getFullYear().toString();
            }
          }
        }
      } catch (e) {
        console.error('Error parsing JSON-LD:', e.message);
      }
    }

    // ── Fallbacks for any missing fields ─────────────────────────────────

    if (!details.title) {
      const ogTitle = $('meta[property="og:title"]').attr('content') || '';
      const match = ogTitle.match(/^(.*)\s+\((\d{4})\)$/);
      if (match) { details.title = match[1]; details.year = match[2]; }
      else details.title = ogTitle || $('h1.headline-1').first().text().trim() || slug;
    }

    if (!details.year) {
      details.year = $('.releasedate a, .releaseyear a').first().text().trim();
    }

    if (!details.description) {
      // og:description is the cleanest fallback
      details.description = $('meta[property="og:description"]').attr('content')
        || $('meta[name="description"]').attr('content')
        || $('.production-synopsis .truncate p').first().text().trim()
        || '';
    }

    if (details.directors.length === 0) {
      const dirs = [];
      $('span.contributorlist a[href*="/director/"], a[href^="/director/"]').each((i, el) => {
        dirs.push($(el).text().trim());
      });
      details.directors = [...new Set(dirs)];
    }

    if (details.cast.length === 0) {
      const actors = [];
      $('#tab-panel-cast .cast-list a.text-slug').each((i, el) => {
        if (i < 10) actors.push($(el).text().trim());
      });
      details.cast = actors;
    }

    if (!details.image) {
      details.image = $('meta[property="og:image"]').attr('content') || '';
    }

    if (details.genres.length === 0) {
      const genres = [];
      $('#tab-panel-genres .text-sluglist a').each((i, el) => {
        genres.push($(el).text().trim());
      });
      details.genres = genres;
    }

    // Original title (non-English)
    details.originalTitle = $('h2.originalname em').first().text().trim() || '';

    // Twitter card director fallback
    if (details.directors.length === 0) {
      const twDir = $('meta[name="twitter:data1"]').attr('content');
      if (twDir) details.directors = [twDir];
    }

    // Rating from twitter card fallback: "4.09 out of 5"
    if (!details.rating) {
      const twRating = $('meta[name="twitter:data2"]').attr('content') || '';
      const rMatch = twRating.match(/([\d.]+)\s+out\s+of/);
      if (rMatch) details.rating = parseFloat(rMatch[1]);
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
