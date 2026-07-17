// Global Application State
let filmList = [];
let currentWheelFilms = [];
let winningFilm = null;
let winningSliceIndex = -1;
let isSpinning = false;
let wheelAngle = 0; // Current rotation angle of the wheel in radians
let spinPromise = null;
let detailsPromise = null;
let detailsCache = {}; // Cache to avoid duplicate fetches

// DOM Elements
const listUrlInput = document.getElementById('list-url');
const genreSelect = document.getElementById('genre-select');
const decadeSelect = document.getElementById('decade-select');
const playlistForm = document.getElementById('playlist-form');
const submitBtn = document.getElementById('submit-btn');
const statusMessage = document.getElementById('status-message');
const listInfo = document.getElementById('list-info');
const listCountBadge = document.getElementById('list-count-badge');
const activeFiltersText = document.getElementById('active-filters-text');
const wheelSection = document.getElementById('wheel-section');
const wheelCanvas = document.getElementById('wheel-canvas');
const spinHubBtn = document.getElementById('spin-hub-btn');
const resultModal = document.getElementById('result-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalCloseBackdrop = document.getElementById('modal-close-backdrop');
const modalLoading = document.getElementById('modal-loading');
const modalDetails = document.getElementById('modal-details');
const moviePoster = document.getElementById('movie-poster');
const movieTitle = document.getElementById('movie-title');
const movieYear = document.getElementById('movie-year');
const movieDirector = document.getElementById('movie-director');
const movieDescription = document.getElementById('movie-description');
const letterboxdLink = document.getElementById('letterboxd-link');
const spinAgainBtn = document.getElementById('spin-again-btn');
const usernameInput = document.getElementById('username-input');
const skipWatchedCheckbox = document.getElementById('skip-watched-checkbox');
const wheelReadout = document.getElementById('wheel-readout');

// Canvas Context
const ctx = wheelCanvas.getContext('2d');
const WHEEL_SLICES = 8;

// Colors for the wheel wedges
const wedgeColors = [
  '#1c252d', // Slate Dark
  '#24303c', // Slightly lighter slate
  '#14181c', // Deep Slate
  '#2a3541'  // Mid Slate
];

// 1. Auto-parse genre/decade if URL pasted with filters
listUrlInput.addEventListener('input', () => {
  const urlVal = listUrlInput.value.trim();
  if (!urlVal) return;

  try {
    const url = new URL(urlVal);
    const path = url.pathname;
    
    const decadeMatch = path.match(/\/decade\/([^/]+)/);
    const genreMatch = path.match(/\/genre\/([^/]+)/);
    
    let filtersDetected = false;
    
    if (decadeMatch) {
      const decodedDecade = decodeURIComponent(decadeMatch[1]);
      if ([...decadeSelect.options].some(opt => opt.value === decodedDecade)) {
        decadeSelect.value = decodedDecade;
        filtersDetected = true;
      }
    }
    if (genreMatch) {
      const decodedGenre = decodeURIComponent(genreMatch[1]);
      if ([...genreSelect.options].some(opt => opt.value === decodedGenre)) {
        genreSelect.value = decodedGenre;
        filtersDetected = true;
      }
    }
    
    if (filtersDetected) {
      // Strip filters from path to keep the base URL clean
      let cleanPath = path;
      if (decadeMatch) cleanPath = cleanPath.replace(/\/decade\/[^/]+/, '');
      if (genreMatch) cleanPath = cleanPath.replace(/\/genre\/[^/]+/, '');
      cleanPath = cleanPath.replace(/\/+/g, '/');
      
      listUrlInput.value = url.origin + cleanPath;
      showStatus('Automatically extracted filters from URL!', 'success');
      setTimeout(() => statusMessage.classList.add('hidden'), 3000);
    }
  } catch (e) {
    // Ignore invalid URL structures during typing
  }
});

// Helper: Show status message
function showStatus(text, type = 'loading') {
  statusMessage.textContent = text;
  statusMessage.className = `status-message ${type}`;
  statusMessage.classList.remove('hidden');
}

// 2. Fetch Playlist and Initialize Wheel
playlistForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (isSpinning) return;

  let baseUr = listUrlInput.value.trim();
  const selectedGenre = genreSelect.value;
  const selectedDecade = decadeSelect.value;
  const username = usernameInput.value.trim();
  const skipWatched = skipWatchedCheckbox.checked;

  // Clean trailing slash
  baseUr = baseUr.replace(/\/$/, '');

  // Append decade/genre in the correct Letterboxd format if selected
  let finalUrl = baseUr;
  if (selectedDecade) {
    finalUrl += `/decade/${selectedDecade}`;
  }
  if (selectedGenre) {
    finalUrl += `/genre/${selectedGenre}`;
  }
  // Ensure trailing slash for Letterboxd URL consistency
  finalUrl += '/';

  showStatus('Connecting to Letterboxd and scraping list...', 'loading');
  submitBtn.disabled = true;

  try {
    const response = await fetch('/api/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        url: finalUrl,
        username: username,
        skipWatched: skipWatched
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to fetch playlist data.');
    }

    filmList = data.films;
    showStatus(`Successfully loaded ${filmList.length} films!`, 'success');
    
    // Update Banner
    listCountBadge.textContent = `${filmList.length} Films`;
    
    let filterText = [];
    if (selectedDecade) filterText.push(`Decade: ${selectedDecade}`);
    if (selectedGenre) filterText.push(`Genre: ${selectedGenre}`);
    if (skipWatched && username) {
      filterText.push(`Skipped ${data.skippedCount || 0} watched (User: ${username})`);
    }
    activeFiltersText.textContent = filterText.length > 0 ? filterText.join(' • ') : 'No active filters';
    listInfo.classList.remove('hidden');

    // Setup wheel elements
    setupWheel();
    wheelSection.classList.remove('hidden');

    // Scroll to wheel smoothly
    wheelSection.scrollIntoView({ behavior: 'smooth' });

  } catch (error) {
    console.error(error);
    showStatus(error.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

// Helper to find the film directly under the pointer (12 o'clock / 270 degrees)
function getFilmUnderPointer(angle) {
  if (currentWheelFilms.length === 0) return null;
  const slices = currentWheelFilms.length;
  const sliceAngle = (2 * Math.PI) / slices;
  
  // 12 o'clock is at 3 * Math.PI / 2
  let localAngle = (3 * Math.PI / 2 - angle) % (2 * Math.PI);
  if (localAngle < 0) {
    localAngle += 2 * Math.PI;
  }
  
  const index = Math.floor(localAngle / sliceAngle) % slices;
  return currentWheelFilms[index];
}

// Setup Wheel with dynamic, readable slices (up to 15)
function setupWheel() {
  if (filmList.length === 0) return;
  
  // If list is small, put all of them. Otherwise, grab a sample of 15 to keep text readable
  const maxSlices = 15;
  if (filmList.length <= maxSlices) {
    currentWheelFilms = [...filmList];
  } else {
    // Shuffled sample of 15 films
    const shuffled = [...filmList].sort(() => 0.5 - Math.random());
    currentWheelFilms = shuffled.slice(0, maxSlices);
  }
  
  wheelAngle = 0;
  drawWheel(0);
  
  if (wheelReadout) {
    wheelReadout.textContent = "Ready to Spin!";
    wheelReadout.style.borderColor = "var(--lb-orange)";
  }
}

// Draw the Roulette Wheel Canvas containing readable slices
function drawWheel(angle) {
  const width = wheelCanvas.width;
  const height = wheelCanvas.height;
  const radius = width / 2;
  const center = radius;

  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  const slices = currentWheelFilms.length;
  if (slices === 0) return;
  
  const sliceAngle = (2 * Math.PI) / slices;

  ctx.save();
  ctx.translate(center, center);
  ctx.rotate(angle);

  // Draw wedges
  for (let i = 0; i < slices; i++) {
    const startAngle = i * sliceAngle;
    const endAngle = startAngle + sliceAngle;

    // Wedge background
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius - 10, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = wedgeColors[i % wedgeColors.length];
    ctx.fill();

    // Divider line
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo((radius - 10) * Math.cos(startAngle), (radius - 10) * Math.sin(startAngle));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw labels inside slices (since slices are always <= 15)
    ctx.save();
    ctx.rotate(startAngle + sliceAngle / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Outfit, sans-serif';

    let titleText = currentWheelFilms[i]?.title || '';
    if (titleText.length > 22) {
      titleText = titleText.substring(0, 20) + '...';
    }

    ctx.fillText(titleText, radius - 35, 0);
    ctx.restore();
  }

  ctx.restore();

  // Draw outer glowing ring overlay
  ctx.beginPath();
  ctx.arc(center, center, radius - 5, 0, 2 * Math.PI);
  ctx.strokeStyle = '#2c3440';
  ctx.lineWidth = 10;
  ctx.stroke();

  // Draw Letterboxd brand tri-color ring border
  const drawTriColorRing = (r, color) => {
    ctx.beginPath();
    ctx.arc(center, center, r, 0, 2 * Math.PI);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  drawTriColorRing(radius - 10, 'rgba(255, 128, 0, 0.4)');

  // Center cap inner hub
  ctx.beginPath();
  ctx.arc(center, center, 42, 0, 2 * Math.PI);
  ctx.fillStyle = '#1c252d';
  ctx.fill();
  ctx.strokeStyle = '#2c3440';
  ctx.lineWidth = 3;
  ctx.stroke();
}

// 3. Spin Animation Logic
async function spinWheel() {
  if (isSpinning || filmList.length === 0) return;

  isSpinning = true;
  spinHubBtn.disabled = true;
  
  if (wheelReadout) {
    wheelReadout.style.borderColor = "var(--lb-orange)";
  }

  // 1. Pick a random winning film from the list
  winningFilm = filmList[Math.floor(Math.random() * filmList.length)];
  console.log(`Winning film chosen: ${winningFilm.title} (${winningFilm.slug})`);

  // 2. Find or place the winning film in our wheel list
  winningSliceIndex = currentWheelFilms.findIndex(f => f.slug === winningFilm.slug);
  if (winningSliceIndex === -1) {
    // Replace a random slice with the winning film
    winningSliceIndex = Math.floor(Math.random() * currentWheelFilms.length);
    currentWheelFilms[winningSliceIndex] = winningFilm;
  }

  // 3. Pre-fetch movie details in background during spin
  fetchMovieDetails(winningFilm.slug);

  // 4. Calculate target rotation
  const slices = currentWheelFilms.length;
  const sliceWidth = (2 * Math.PI) / slices;
  const targetPointerAngle = 3 * Math.PI / 2; // 12 o'clock pointer
  const sliceCenterAngle = (winningSliceIndex * sliceWidth) + (sliceWidth / 2);
  
  let finalAngle = targetPointerAngle - sliceCenterAngle;
  while (finalAngle < 0) {
    finalAngle += 2 * Math.PI;
  }

  // Add 6 to 8 full rotations for momentum
  const totalRotations = 6 + Math.floor(Math.random() * 3);
  const targetAngle = finalAngle + (totalRotations * 2 * Math.PI);
  
  const startAngle = wheelAngle % (2 * Math.PI);
  const spinDistance = targetAngle - startAngle;
  
  const duration = 5000;
  const startTime = performance.now();

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function animate(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    
    const currentProgress = easeOutCubic(progress);
    wheelAngle = startAngle + (spinDistance * currentProgress);

    drawWheel(wheelAngle);
    
    // Update live title readout banner dynamically
    const activeFilm = getFilmUnderPointer(wheelAngle);
    if (activeFilm && wheelReadout) {
      wheelReadout.textContent = activeFilm.title;
      
      // Cycle borders during spins
      const borderColors = ["var(--lb-orange)", "var(--lb-green)", "var(--lb-blue)"];
      const col = borderColors[Math.floor(wheelAngle * 4.5) % borderColors.length];
      wheelReadout.style.borderColor = col;
    }

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      finishSpin();
    }
  }

  requestAnimationFrame(animate);
}

// Trigger background details fetch
function fetchMovieDetails(slug) {
  if (detailsCache[slug]) {
    detailsPromise = Promise.resolve(detailsCache[slug]);
    return;
  }

  detailsPromise = fetch(`/api/movie-details?slug=${slug}`)
    .then(res => {
      if (!res.ok) throw new Error('Details fetch failed');
      return res.json();
    })
    .then(data => {
      detailsCache[slug] = data;
      return data;
    })
    .catch(err => {
      console.error(err);
      // Fallback details object in case of scrape failures
      return {
        title: winningFilm.title,
        year: 'N/A',
        directors: ['Unknown'],
        description: 'Failed to retrieve film synopsis from Letterboxd. Please view on Letterboxd website.',
        image: winningFilm.posterUrl || '',
        link: `https://letterboxd.com/film/${slug}/`
      };
    });
}

// Complete the spin, show confetti and trigger results modal
async function finishSpin() {
  isSpinning = false;
  spinHubBtn.disabled = false;
  
  // Set readout to the winning film name highlighted in green
  if (wheelReadout && winningFilm) {
    wheelReadout.textContent = `🎯 ${winningFilm.title}`;
    wheelReadout.style.borderColor = "var(--lb-green)";
  }

  // Trigger celebration Confetti
  confetti({
    particleCount: 120,
    spread: 70,
    origin: { y: 0.6 }
  });

  // Open modal
  resultModal.classList.remove('hidden');
  modalLoading.classList.remove('hidden');
  modalDetails.classList.add('hidden');

  try {
    const details = await detailsPromise;
    
    movieTitle.textContent = details.title;
    movieYear.textContent = details.year || 'N/A';
    movieDirector.textContent = details.directors.length > 0 ? details.directors.join(', ') : 'Unknown';
    movieDescription.textContent = details.description || 'No description available for this film.';
    letterboxdLink.href = details.link;
    
    moviePoster.src = details.image || winningFilm.posterUrl || 'https://a.ltrbxd.com/resized/empty-poster-150.png';

    modalLoading.classList.add('hidden');
    modalDetails.classList.remove('hidden');
  } catch (error) {
    console.error(error);
    modalLoading.classList.add('hidden');
  }
}

// 4. Modal Interactions
function closeModal() {
  resultModal.classList.add('hidden');
}

modalCloseBtn.addEventListener('click', closeModal);
modalCloseBackdrop.addEventListener('click', closeModal);
spinAgainBtn.addEventListener('click', () => {
  closeModal();
  spinWheel();
});

// Spin Hub & Spacebar Trigger
spinHubBtn.addEventListener('click', spinWheel);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    // Don't trigger if user is typing in inputs
    if (document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
      e.preventDefault();
      // If modal is open, close it, else spin!
      if (!resultModal.classList.contains('hidden')) {
        closeModal();
      } else {
        spinWheel();
      }
    }
  }
});
