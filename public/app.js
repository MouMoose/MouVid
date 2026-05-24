// MouVid Client Application Controller

let libraryData = { movies: [], shows: [], isScanning: false };
let currentFocused = null;
let lastFocusedMediaCard = null;
let activeModalMedia = null;
let coverPickerTarget = null; // { id, type } of the card being edited
let lastFocusedBeforePicker = null;
let isHUDVisible = true;
let hudTimeout = null;
let activeGenreFilters = new Set();
let genreFilterMode = 'or'; // 'or' | 'and'

// DOM Elements
const navbar = document.getElementById('navbar');
const railsContainer = document.getElementById('rails-container');
const detailsModal = document.getElementById('details-modal');
const settingsPanel = document.getElementById('settings-panel');
const coverPickerModal = document.getElementById('cover-picker-modal');
const videoPlayerContainer = document.getElementById('video-player-container');
const videoElement = document.getElementById('video-element');
const statusDot = document.querySelector('.status-dot');
const statusText = document.getElementById('status-text');

// Initialize App
window.addEventListener('DOMContentLoaded', () => {
  fetchSettings();
  fetchLibrary(true);
  
  // Set up click/enter handlers for structural items
  setupInteractivity();
  setupSpatialNavigation();
  setupVideoPlayer();
  
  // Poll scanning status every 3 seconds
  setInterval(() => {
    fetchLibrary(false);
  }, 3000);
});

// Fetch Library Data
async function fetchLibrary(isInitial = false) {
  try {
    const response = await fetch('/api/library');
    const data = await response.json();

    updateScanStatus(data.isScanning, data.scanMessage || '');

    if (isInitial) {
      libraryData = data;
      renderLibrary();
      return;
    }

    // Check if items were added or removed (structural change → full re-render)
    const sameMovieIds = JSON.stringify(data.movies.map(m => m.id)) === JSON.stringify(libraryData.movies.map(m => m.id));
    const sameShowIds  = JSON.stringify(data.shows.map(s => s.id))  === JSON.stringify(libraryData.shows.map(s => s.id));
    const sameWatchHistory = JSON.stringify((data.watchHistory || []).map(w => w.id + w.watchedAt)) === JSON.stringify((libraryData.watchHistory || []).map(w => w.id + w.watchedAt));

    if (!sameMovieIds || !sameShowIds || !sameWatchHistory) {
      libraryData = data;
      renderLibrary();
      return;
    }

    // Same items — only patch poster URLs in-place to avoid destroying existing images
    data.movies.forEach(movie => {
      const old = libraryData.movies.find(m => m.id === movie.id);
      if (old && old.poster !== movie.poster && movie.poster) {
        old.poster = movie.poster;
        document.querySelectorAll(`.media-card[data-id="${movie.id}"] .media-card-img`).forEach(img => {
          img.src = movie.poster;
        });
      }
    });

    data.shows.forEach(show => {
      const old = libraryData.shows.find(s => s.id === show.id);
      if (old && old.poster !== show.poster && show.poster) {
        old.poster = show.poster;
        document.querySelectorAll(`.media-card[data-id="${show.id}"] .media-card-img`).forEach(img => {
          img.src = show.poster;
        });
      }
    });

  } catch (error) {
    console.error('Error fetching library:', error);
    updateScanStatus(false);
  }
}

// Fetch Settings
function setKeyStatus(provider, configured, testResult = null) {
  const el = document.getElementById(`${provider}-key-status`);
  if (!el) return;
  if (testResult !== null) {
    el.textContent = testResult.success ? `✓ ${testResult.message || 'Valid'}` : `✗ ${testResult.message || 'Invalid'}`;
    el.className = 'api-key-status ' + (testResult.success ? 'key-valid' : 'key-invalid');
  } else {
    el.textContent = configured ? '● Configured' : '○ Not set';
    el.className = 'api-key-status ' + (configured ? 'key-configured' : 'key-unconfigured');
  }
}

async function testApiKey(provider) {
  const input = document.getElementById(`settings-${provider}-key`);
  const btn = document.getElementById(`${provider}-test-btn`);
  const key = input.value.trim();
  if (!key) {
    setKeyStatus(provider, false, { success: false, message: 'Enter a key first' });
    setTimeout(() => fetchSettings(), 2500);
    return;
  }
  btn.textContent = '...';
  btn.disabled = true;
  try {
    const res = await fetch(`/api/test-key?provider=${provider}&key=${encodeURIComponent(key)}`);
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) {
      // Server returned non-JSON (e.g. HTML 404) — endpoint not registered yet
      setKeyStatus(provider, false, { success: false, message: 'Server needs a restart to enable testing' });
      setTimeout(() => fetchSettings(), 4000);
      return;
    }
    const data = await res.json();
    setKeyStatus(provider, false, data);
    setTimeout(() => fetchSettings(), 3000);
  } catch {
    setKeyStatus(provider, false, { success: false, message: 'Could not reach server' });
    setTimeout(() => fetchSettings(), 3000);
  } finally {
    btn.textContent = 'Test';
    btn.disabled = false;
  }
}

async function fetchSettings() {
  try {
    const response = await fetch('/api/settings');
    const config = await response.json();
    document.getElementById('settings-paths-input').value = config.mediaPaths.join(', ');
    setKeyStatus('tmdb', !!config.tmdbApiKey);
    setKeyStatus('omdb', !!config.omdbApiKey);
    document.getElementById('settings-tmdb-key').placeholder = config.tmdbApiKey ? '(key saved — enter new to replace)' : 'Paste TMDB API key (v3 auth)';
    document.getElementById('settings-omdb-key').placeholder = config.omdbApiKey ? '(key saved — enter new to replace)' : 'Paste OMDB API key';
    document.getElementById('lan-url-display').textContent = `http://${window.location.hostname}:${window.location.port || 3000}`;
  } catch (error) {
    console.error('Error fetching settings:', error);
  }
}

// Update Scan Status UI
function updateScanStatus(isScanning, message = '') {
  const indicator = document.getElementById('status-indicator');
  const bar = document.getElementById('scan-status-bar');
  const barMsg = document.getElementById('scan-status-msg');
  if (isScanning) {
    indicator.classList.add('scanning');
    statusText.textContent = 'Scanning…';
    bar.classList.remove('hidden');
    barMsg.textContent = message || 'Scanning…';
  } else {
    indicator.classList.remove('scanning');
    statusText.textContent = 'Connected';
    bar.classList.add('hidden');
  }
}

// Render library catalog into Netflix rows
function renderLibrary() {
  if (isScanningLibrary() && libraryData.movies.length === 0 && libraryData.shows.length === 0) {
    railsContainer.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Scanning media directories...</p>
      </div>
    `;
    return;
  }

  if (libraryData.movies.length === 0 && libraryData.shows.length === 0) {
    railsContainer.innerHTML = `
      <div class="empty-state">
        <h3>Your Media Library is Empty</h3>
        <p>We couldn't find any movies or TV series in <code>E:\\Media</code>. Please verify that your external drive is plugged in or configure additional scan paths in Settings.</p>
        <button class="btn btn-primary focusable" id="empty-state-settings" tabindex="0">Open Settings</button>
      </div>
    `;
    // Set focus to the settings button in empty state
    const btn = document.getElementById('empty-state-settings');
    if (btn) {
      btn.addEventListener('click', () => toggleSettings(true));
      setTimeout(() => setFocus(btn), 200);
    }
    return;
  }

  railsContainer.innerHTML = '';

  // 0. Row: Recently Watched
  if (libraryData.watchHistory && libraryData.watchHistory.length > 0) {
    createRailRow('Recently Watched', libraryData.watchHistory);
  }

  // 1. Row: Recently Added (Combined Movies and Shows)
  const recentlyAdded = [];
  libraryData.movies.forEach(m => recentlyAdded.push({ ...m, mediaType: 'movie' }));
  libraryData.shows.forEach(s => recentlyAdded.push({ ...s, mediaType: 'show' }));
  recentlyAdded.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  
  if (recentlyAdded.length > 0) {
    createRailRow('Recently Added', recentlyAdded.slice(0, 10));
  }

  // 2. Row: Movies
  if (libraryData.movies.length > 0) {
    createRailRow('Movies', libraryData.movies.map(m => ({ ...m, mediaType: 'movie' })));
  }

  // 3. Row: TV Series
  if (libraryData.shows.length > 0) {
    createRailRow('TV Series', libraryData.shows.map(s => ({ ...s, mediaType: 'show' })));
  }

  // Setup dynamic cover elements rendering, bind cards click events
  setupCardEvents();
  
  // Set default hero banner featured movie if available
  updateHeroBanner();

  // Build genre filter bar
  buildGenreBar();
}

function isScanningLibrary() {
  const indicator = document.getElementById('status-indicator');
  return indicator.classList.contains('scanning');
}

// Create a horizontal slider rail
function createRailRow(title, items) {
  const railDiv = document.createElement('div');
  railDiv.className = 'rail';
  
  const titleH2 = document.createElement('h2');
  titleH2.className = 'rail-title';
  titleH2.textContent = title;
  railDiv.appendChild(titleH2);
  
  const rowDiv = document.createElement('div');
  rowDiv.className = 'rail-row';
  
  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'media-card focusable';
    card.setAttribute('tabindex', '0');
    card.dataset.id = item.id;
    card.dataset.type = item.mediaType;
    card.dataset.genres = JSON.stringify(item.genres || []);

    const img = document.createElement('img');
    img.className = 'media-card-img';
    img.src = item.poster;
    img.alt = item.title;
    
    // If image fails to load, use a beautiful fallback layout with text title
    img.onerror = () => {
      img.remove();
      const fallback = document.createElement('div');
      fallback.className = 'media-card-fallback';
      
      // Select a nice gradient background based on ID hash
      const hue = parseInt(item.id.substring(0, 3), 16) % 360;
      fallback.style.background = `linear-gradient(135deg, hsl(${hue}, 70%, 25%) 0%, #141414 100%)`;
      
      const titleSpan = document.createElement('span');
      titleSpan.className = 'fallback-title';
      titleSpan.textContent = item.title;
      fallback.appendChild(titleSpan);

      if (item.year) {
        const yearSpan = document.createElement('span');
        yearSpan.className = 'fallback-year';
        yearSpan.textContent = item.year;
        fallback.appendChild(yearSpan);
      }
      card.appendChild(fallback);
    };

    card.appendChild(img);
    rowDiv.appendChild(card);
  });
  
  railDiv.appendChild(rowDiv);
  railsContainer.appendChild(railDiv);
}

// Set up event listeners for dynamically created media cards
function setupCardEvents() {
  const cards = document.querySelectorAll('.media-card');
  cards.forEach(card => {
    card.addEventListener('click', () => {
      openDetailsModal(card.dataset.id, card.dataset.type);
    });
  });
}

// Set featured banner on top
function updateHeroBanner() {
  let featured = null;
  
  if (libraryData.movies.length > 0) {
    featured = libraryData.movies[0];
    featured.mediaType = 'movie';
  } else if (libraryData.shows.length > 0) {
    featured = libraryData.shows[0];
    featured.mediaType = 'show';
  }
  
  if (!featured) return;
  
  document.getElementById('hero-title').textContent = featured.title;
  document.getElementById('hero-meta').textContent = `${featured.year || ''} • ${featured.mediaType.toUpperCase()}`;
  document.getElementById('hero-synopsis').textContent = featured.mediaType === 'movie' 
    ? `Stream this movie directly from your local computer storage.` 
    : `Watch seasons and episodes of this series on your local LAN connection.`;

  const heroBackdrop = document.getElementById('hero-backdrop');
  heroBackdrop.style.backgroundImage = `url(${featured.poster})`;
  
  // Bind actions
  const playBtn = document.getElementById('hero-play');
  const infoBtn = document.getElementById('hero-info');
  
  playBtn.onclick = () => {
    if (featured.mediaType === 'movie') {
      playVideo(featured.title, featured.path);
    } else {
      openDetailsModal(featured.id, 'show');
    }
  };
  
  infoBtn.onclick = () => {
    openDetailsModal(featured.id, featured.mediaType);
  };
}

// Open Details modal overlay
function openDetailsModal(id, type) {
  let media = null;
  if (type === 'movie') {
    media = libraryData.movies.find(m => m.id === id);
    media.mediaType = 'movie';
  } else {
    media = libraryData.shows.find(s => s.id === id);
    media.mediaType = 'show';
  }
  
  if (!media) return;
  
  activeModalMedia = media;
  lastFocusedMediaCard = document.activeElement; // Remember card for return focus

  document.getElementById('modal-title').textContent = media.title;
  document.getElementById('modal-year').textContent = media.year || 'Series';
  document.getElementById('modal-type-tag').textContent = type.toUpperCase();
  document.getElementById('modal-poster').src = media.poster;

  // Genres
  const genresEl = document.getElementById('modal-genres');
  genresEl.innerHTML = '';
  (media.genres || []).forEach(g => {
    const pill = document.createElement('span');
    pill.className = 'modal-genre-pill';
    pill.textContent = g;
    genresEl.appendChild(pill);
  });
  
  const epSection = document.getElementById('episodes-section');
  const playBtn = document.getElementById('modal-play-btn');
  const openWithSection = document.getElementById('modal-open-with-section');
  // Always reset open-with panel when modal opens
  document.getElementById('open-with-options').classList.add('hidden');
  
  if (type === 'movie') {
    epSection.style.display = 'none';
    playBtn.style.display = 'inline-flex';
    openWithSection.classList.remove('hidden');
    document.getElementById('modal-duration').textContent = 'Movie';
    document.getElementById('modal-synopsis').textContent = 'Play this local movie directly.';
    document.getElementById('modal-path').textContent = media.path;
    
    playBtn.onclick = () => {
      playVideo(media.title, media.path);
    };
  } else {
    // Show series detail
    epSection.style.display = 'flex';
    playBtn.style.display = 'none';
    openWithSection.classList.add('hidden');
    document.getElementById('modal-duration').textContent = `${Object.keys(media.seasons).length} Seasons`;
    document.getElementById('modal-synopsis').textContent = 'Browse episodes for this series.';

    // Derive show folder from first episode path (go up 2 levels: file → season → show)
    const seasonKeys = Object.keys(media.seasons).sort((a,b) => parseInt(a) - parseInt(b));
    let showFolder = '';
    if (seasonKeys.length > 0) {
      const firstEp = (media.seasons[seasonKeys[0]] || [])[0];
      if (firstEp && firstEp.path) {
        const sep = firstEp.path.includes('\\') ? '\\' : '/';
        const parts = firstEp.path.split(sep);
        parts.splice(-2);
        showFolder = parts.join(sep);
      }
    }
    document.getElementById('modal-path').textContent = showFolder;

    // Build Seasons Selector
    const seasonSelect = document.getElementById('season-select');
    seasonSelect.innerHTML = '';
    seasonKeys.forEach(season => {
      const option = document.createElement('option');
      option.value = season;
      option.textContent = `Season ${season}`;
      seasonSelect.appendChild(option);
    });
    
    seasonSelect.onchange = () => {
      renderEpisodeList(media, seasonSelect.value);
    };

    if (seasonKeys.length > 0) {
      renderEpisodeList(media, seasonKeys[0]);
    }
  }
  
  detailsModal.classList.add('active');
  
  // Shift focus to close button or play button in modal
  setTimeout(() => {
    if (type === 'movie') {
      setFocus(document.getElementById('modal-play-btn'));
    } else {
      setFocus(document.getElementById('season-select'));
    }
  }, 100);
}

// Render episode grid in detail modal
function renderEpisodeList(show, seasonNumber) {
  const container = document.getElementById('episodes-list');
  container.innerHTML = '';
  container.className = 'episode-grid';

  const episodes = show.seasons[seasonNumber] || [];
  episodes.forEach(ep => {
    const tile = document.createElement('div');
    tile.className = 'episode-tile focusable';
    tile.setAttribute('tabindex', '0');

    const num = document.createElement('span');
    num.className = 'ep-num';
    num.textContent = `E${ep.episodeNumber.toString().padStart(2, '0')}`;

    const name = document.createElement('span');
    name.className = 'ep-title';
    name.textContent = ep.title;

    tile.appendChild(num);
    tile.appendChild(name);

    tile.onclick = () => {
      playVideo(`${show.title} - S${seasonNumber.toString().padStart(2, '0')}E${ep.episodeNumber.toString().padStart(2, '0')} - ${ep.title}`, ep.path);
    };

    container.appendChild(tile);
  });
}

function closeDetailsModal() {
  detailsModal.classList.remove('active');
  activeModalMedia = null;
  document.getElementById('open-with-options').classList.add('hidden');
  
  // Return focus to the card that triggered the modal
  if (lastFocusedMediaCard) {
    setFocus(lastFocusedMediaCard);
  } else {
    setFocus(document.getElementById('nav-home'));
  }
}

// Settings Overlay Management
function toggleSettings(show) {
  if (show) {
    settingsPanel.classList.add('active');
    setTimeout(() => {
      setFocus(document.getElementById('settings-paths-input'));
    }, 150);
  } else {
    settingsPanel.classList.remove('remove');
    settingsPanel.classList.remove('active');
    if (lastFocusedMediaCard) {
      setFocus(lastFocusedMediaCard);
    } else {
      setFocus(document.getElementById('nav-home'));
    }
  }
}

// Save settings to server
async function saveSettings() {
  const pathsInput = document.getElementById('settings-paths-input').value;
  const paths = pathsInput.split(',').map(p => p.trim()).filter(p => p.length > 0);
  const tmdbApiKey = document.getElementById('settings-tmdb-key').value.trim();
  const omdbApiKey = document.getElementById('settings-omdb-key').value.trim();

  const body = { mediaPaths: paths };
  // Only include keys if the user typed something (empty = leave unchanged would be confusing; send empty to clear)
  if (tmdbApiKey !== '') body.tmdbApiKey = tmdbApiKey;
  if (omdbApiKey !== '') body.omdbApiKey = omdbApiKey;
  // If user left a field blank but it was previously set, preserve it by not sending — but since
  // the placeholder just shows "(key saved)", we only send when non-empty.
  // To support clearing a key the user can enter a single space then Save.
  
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (response.ok) {
      alert("Settings saved successfully!");
      document.getElementById('settings-tmdb-key').value = '';
      document.getElementById('settings-omdb-key').value = '';
      await fetchSettings(); // refresh placeholders
      toggleSettings(false);
      fetchLibrary(true); // reload
    } else {
      alert("Failed to save settings.");
    }
  } catch (error) {
    console.error("Error saving settings:", error);
  }
}

// Trigger explicit media library scan
async function triggerScan() {
  const btn = document.getElementById('settings-scan-btn');
  const btnText = btn.querySelector('.scan-btn-text');
  
  btnText.textContent = "Scanning initiated...";
  
  try {
    const response = await fetch('/api/scan', { method: 'POST' });
    if (response.ok) {
      updateScanStatus(true);
      toggleSettings(false);
    } else {
      const data = await response.json();
      alert(data.message || "Failed to trigger scan.");
    }
  } catch (error) {
    console.error("Error triggering scan:", error);
  } finally {
    btnText.textContent = "Rescan Library";
  }
}

// Setup basic non-spatial actions
function setupInteractivity() {
  // Brand Logo
  document.getElementById('nav-brand').addEventListener('click', () => {
    window.location.reload();
  });
  
  // Links
  document.getElementById('nav-home').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  
  document.getElementById('nav-movies').addEventListener('click', () => {
    const moviesTitle = Array.from(document.querySelectorAll('.rail-title')).find(el => el.textContent === 'Movies');
    if (moviesTitle) {
      moviesTitle.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  document.getElementById('nav-shows').addEventListener('click', () => {
    const showsTitle = Array.from(document.querySelectorAll('.rail-title')).find(el => el.textContent === 'TV Series');
    if (showsTitle) {
      showsTitle.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  document.getElementById('nav-settings-btn').addEventListener('click', () => toggleSettings(true));
  
  // Settings Panel Buttons
  document.getElementById('settings-close').addEventListener('click', () => toggleSettings(false));
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);
  document.getElementById('settings-scan-btn').addEventListener('click', triggerScan);
  document.getElementById('tmdb-test-btn').addEventListener('click', () => testApiKey('tmdb'));
  document.getElementById('omdb-test-btn').addEventListener('click', () => testApiKey('omdb'));
  
  // Details Modal close
  document.getElementById('modal-close').addEventListener('click', closeDetailsModal);
  document.getElementById('modal-backdrop').addEventListener('click', closeDetailsModal);

  // Cover Art Picker close
  document.getElementById('cover-picker-close').addEventListener('click', closeCoverArtPicker);
  document.getElementById('cover-picker-backdrop').addEventListener('click', closeCoverArtPicker);

  // Refresh Library button
  document.getElementById('nav-refresh-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/scan', { method: 'POST' });
      updateScanStatus(true);
    } catch (e) {
      console.error('Refresh failed:', e);
    }
  });

  // Change Cover button (in details modal)
  document.getElementById('modal-change-cover-btn').addEventListener('click', () => {
    if (activeModalMedia) openCoverArtPicker(activeModalMedia.id, activeModalMedia.mediaType);
  });

  // Open With button and options
  document.getElementById('modal-open-with-btn').addEventListener('click', toggleOpenWith);
  document.getElementById('owith-builtin').addEventListener('click', () => openWithPlayer('builtin'));
  document.getElementById('owith-browser').addEventListener('click', () => openWithPlayer('browser'));
  document.getElementById('owith-vlc').addEventListener('click', () => openWithPlayer('vlc'));
  
  // Navbar scroll background effect
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      navbar.classList.add('scrolled');
    } else {
      navbar.classList.remove('scrolled');
    }
  });

  // Client search engine
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    const term = searchInput.value.toLowerCase().trim();
    filterLibraryCards(term);
  });
}

// ==========================================
// GENRE FILTER BAR
// ==========================================

function buildGenreBar() {
  const bar = document.getElementById('genre-bar');
  if (!bar) return;

  // Collect all unique genres across movies and shows
  const allGenres = new Set();
  [...libraryData.movies, ...libraryData.shows].forEach(item => {
    (item.genres || []).forEach(g => allGenres.add(g));
  });

  bar.innerHTML = '';
  if (allGenres.size === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  // AND / OR toggle
  const modeToggle = document.createElement('div');
  modeToggle.className = 'genre-mode-toggle';

  ['OR', 'AND'].forEach(mode => {
    const btn = document.createElement('button');
    btn.className = 'genre-mode-btn' + (genreFilterMode === mode.toLowerCase() ? ' active' : '');
    btn.textContent = mode;
    btn.onclick = () => {
      genreFilterMode = mode.toLowerCase();
      bar.querySelectorAll('.genre-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyGenreFilter();
    };
    modeToggle.appendChild(btn);
  });
  bar.appendChild(modeToggle);

  // Genre pills
  Array.from(allGenres).sort().forEach(genre => {
    const pill = document.createElement('button');
    pill.className = 'genre-pill focusable' + (activeGenreFilters.has(genre) ? ' active' : '');
    pill.textContent = genre;
    pill.setAttribute('tabindex', '0');
    pill.onclick = () => {
      if (activeGenreFilters.has(genre)) {
        activeGenreFilters.delete(genre);
        pill.classList.remove('active');
      } else {
        activeGenreFilters.add(genre);
        pill.classList.add('active');
      }
      applyGenreFilter();
    };
    bar.appendChild(pill);
  });

  // Clear button
  const clearBtn = document.createElement('button');
  clearBtn.className = 'genre-clear-btn focusable';
  clearBtn.textContent = 'Clear';
  clearBtn.setAttribute('tabindex', '0');
  clearBtn.onclick = () => {
    activeGenreFilters.clear();
    bar.querySelectorAll('.genre-pill').forEach(p => p.classList.remove('active'));
    applyGenreFilter();
  };
  bar.appendChild(clearBtn);
}

function applyGenreFilter() {
  const cards = document.querySelectorAll('.media-card');

  cards.forEach(card => {
    if (activeGenreFilters.size === 0) {
      card.style.display = '';
    } else {
      const cardGenres = JSON.parse(card.dataset.genres || '[]');
      const match = genreFilterMode === 'or'
        ? cardGenres.some(g => activeGenreFilters.has(g))
        : [...activeGenreFilters].every(g => cardGenres.includes(g));
      card.style.display = match ? '' : 'none';
    }
  });

  // Hide rails where all cards are hidden
  document.querySelectorAll('.rail').forEach(rail => {
    const visible = rail.querySelectorAll('.media-card:not([style*="display: none"])');
    rail.style.display = visible.length > 0 ? '' : 'none';
  });
}

// Filter library items on typing
function filterLibraryCards(term) {
  const cards = document.querySelectorAll('.media-card');
  let firstVisibleCard = null;

  cards.forEach(card => {
    const titleEl = card.querySelector('.fallback-title') || card.querySelector('.media-card-img');
    const titleText = titleEl ? (titleEl.textContent || titleEl.alt).toLowerCase() : '';
    
    if (titleText.includes(term)) {
      card.style.display = 'block';
      if (!firstVisibleCard) firstVisibleCard = card;
    } else {
      card.style.display = 'none';
    }
  });

  // Hide entire rails if empty
  const rails = document.querySelectorAll('.rail');
  rails.forEach(rail => {
    const visibleCards = rail.querySelectorAll('.media-card[style*="display: block"], .media-card:not([style*="display: none"])');
    if (visibleCards.length === 0) {
      rail.style.display = 'none';
    } else {
      rail.style.display = 'block';
    }
  });
}

// ==========================================
// SPATIAL NAVIGATION (TV REMOTE CONTROL ENGINE)
// ==========================================

function getFocusableElements() {
  return Array.from(document.querySelectorAll('.focusable')).filter(el => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    const detailsActive = detailsModal.classList.contains('active');
    const settingsActive = settingsPanel.classList.contains('active');
    const pickerActive = coverPickerModal.classList.contains('active');
    const playerActive = videoPlayerContainer.classList.contains('active');

    const inDetails = el.closest('#details-modal');
    const inSettings = el.closest('#settings-panel');
    const inPicker = el.closest('#cover-picker-modal');
    const inPlayer = el.closest('#video-player-container');

    if (playerActive) return !!inPlayer;
    if (settingsActive) return !!inSettings;
    if (pickerActive) return !!inPicker;
    if (detailsActive) return !!inDetails;

    return !inDetails && !inSettings && !inPicker && !inPlayer;
  });
}

function setFocus(element) {
  if (!element) return;
  
  document.querySelectorAll('.focusable').forEach(el => el.classList.remove('focused'));
  
  currentFocused = element;
  element.classList.add('focused');
  element.focus();

  // 1. Auto-scroll movie rails
  const row = element.closest('.rail-row');
  if (row) {
    const cardRect = element.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    
    if (cardRect.right > rowRect.right - 80) {
      row.scrollLeft += (cardRect.right - rowRect.right + 180);
    } else if (cardRect.left < rowRect.left + 80) {
      row.scrollLeft -= (rowRect.left - cardRect.left + 180);
    }
  }

  // 2. Auto-scroll episode lists
  const epList = element.closest('.episodes-list');
  if (epList) {
    const epRect = element.getBoundingClientRect();
    const listRect = epList.getBoundingClientRect();
    
    if (epRect.bottom > listRect.bottom - 20) {
      epList.scrollTop += (epRect.bottom - listRect.bottom + 60);
    } else if (epRect.top < listRect.top + 20) {
      epList.scrollTop -= (listRect.top - epRect.top + 60);
    }
  }
}

// Calculate spatial layout distance to match D-Pad direction
function getDistance(currRect, candRect, direction) {
  const currCenter = {
    x: currRect.left + currRect.width / 2,
    y: currRect.top + currRect.height / 2
  };
  const candCenter = {
    x: candRect.left + candRect.width / 2,
    y: candRect.top + candRect.height / 2
  };

  const dx = candCenter.x - currCenter.x;
  const dy = candCenter.y - currCenter.y;

  // We weight the orthogonal direction heavily so that we stay in the active row/column
  const orthogonalWeight = 6; 

  switch (direction) {
    case 'right':
      if (dx <= 1) return Infinity; // Must be to the right
      return dx + orthogonalWeight * Math.abs(dy);
    case 'left':
      if (dx >= -1) return Infinity; // Must be to the left
      return -dx + orthogonalWeight * Math.abs(dy);
    case 'down':
      if (dy <= 1) return Infinity; // Must be below
      return dy + orthogonalWeight * Math.abs(dx);
    case 'up':
      if (dy >= -1) return Infinity; // Must be above
      return -dy + orthogonalWeight * Math.abs(dx);
    default:
      return Infinity;
  }
}

function navigateSpatial(direction) {
  const focusables = getFocusableElements();
  if (focusables.length === 0) return;

  // If nothing is active, default to first focusable
  if (!currentFocused || !focusables.includes(currentFocused)) {
    // If details modal active
    if (detailsModal.classList.contains('active')) {
      const close = document.getElementById('modal-close');
      setFocus(close);
    } else {
      setFocus(focusables[0]);
    }
    return;
  }

  const currRect = currentFocused.getBoundingClientRect();
  let bestCandidate = null;
  let minDistance = Infinity;

  focusables.forEach(candidate => {
    if (candidate === currentFocused) return;
    const candRect = candidate.getBoundingClientRect();
    
    const dist = getDistance(currRect, candRect, direction);
    if (dist < minDistance) {
      minDistance = dist;
      bestCandidate = candidate;
    }
  });

  if (bestCandidate) {
    setFocus(bestCandidate);
  }
}

function setupSpatialNavigation() {
  window.addEventListener('keydown', (e) => {
    const isPlayerActive = videoPlayerContainer.classList.contains('active');

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        if (isPlayerActive) { showHUD(); } else { navigateSpatial('up'); }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (isPlayerActive) { showHUD(); } else { navigateSpatial('down'); }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (isPlayerActive) {
          showHUD();
          if (document.activeElement.id === 'progress-container') { seekVideoDelta(-15); }
          else { navigateSpatial('left'); }
        } else {
          navigateSpatial('left');
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (isPlayerActive) {
          showHUD();
          if (document.activeElement.id === 'progress-container') { seekVideoDelta(15); }
          else { navigateSpatial('right'); }
        } else {
          navigateSpatial('right');
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (currentFocused && currentFocused.classList.contains('focusable')) {
          currentFocused.click();
        }
        break;
      case 'Escape':
      case 'Backspace':
        if (coverPickerModal.classList.contains('active')) {
          e.preventDefault();
          closeCoverArtPicker();
        } else if (isPlayerActive) {
          e.preventDefault();
          stopVideo();
        } else if (settingsPanel.classList.contains('active')) {
          e.preventDefault();
          toggleSettings(false);
        } else if (detailsModal.classList.contains('active')) {
          e.preventDefault();
          closeDetailsModal();
        } else {
          // Main menu — confirm before exiting
          if (confirm('Exit MouVid?')) window.close();
        }
        break;
      default:
        if (isPlayerActive) { showHUD(); }
        break;
    }
  });

  // Default focus on boot
  setTimeout(() => {
    const homeBtn = document.getElementById('nav-home');
    if (homeBtn) setFocus(homeBtn);
  }, 500);
}

// ==========================================
// OPEN WITH PLAYER
// ==========================================

function toggleOpenWith() {
  document.getElementById('open-with-options').classList.toggle('hidden');
}

function openWithPlayer(playerType) {
  if (!activeModalMedia) return;
  document.getElementById('open-with-options').classList.add('hidden');

  const streamUrl = `/api/stream?videoPath=${encodeURIComponent(activeModalMedia.path)}`;
  const fullStreamUrl = `${window.location.origin}${streamUrl}`;

  switch (playerType) {
    case 'builtin':
      closeDetailsModal();
      playVideo(activeModalMedia.title, activeModalMedia.path);
      break;
    case 'browser':
      window.open(fullStreamUrl, '_blank', 'noopener');
      break;
    case 'vlc':
      window.location.href = `vlc://${fullStreamUrl}`;
      break;
  }
}

// ==========================================
// COVER ART PICKER
// ==========================================

function openCoverArtPicker(id, type) {
  coverPickerTarget = { id, type };
  lastFocusedBeforePicker = currentFocused;

  // Find media item title for display
  let item = type === 'movie'
    ? libraryData.movies.find(m => m.id === id)
    : libraryData.shows.find(s => s.id === id);

  const subtitle = document.getElementById('cover-picker-subtitle');
  subtitle.textContent = item ? item.title : '';

  const grid = document.getElementById('cover-picker-grid');
  const loading = document.getElementById('cover-picker-loading');
  grid.innerHTML = '';
  loading.classList.remove('hidden');

  coverPickerModal.classList.add('active');
  setTimeout(() => setFocus(document.getElementById('cover-picker-close')), 100);

  fetch(`/api/cover-search?id=${encodeURIComponent(id)}&type=${encodeURIComponent(type)}`)
    .then(r => r.json())
    .then(data => {
      loading.classList.add('hidden');
      const candidates = data.candidates || [];

      if (candidates.length === 0) {
        grid.innerHTML = '<p class="cover-picker-empty">No cover art found online for this title.</p>';
        return;
      }

      candidates.forEach((candidate, index) => {
        const option = document.createElement('div');
        option.className = 'cover-option focusable';
        option.setAttribute('tabindex', '0');
        option.dataset.url = candidate.url;

        const img = document.createElement('img');
        img.src = candidate.url;
        img.alt = candidate.label || 'Cover art option';
        img.loading = 'lazy';
        img.onerror = () => { option.style.display = 'none'; };

        const label = document.createElement('div');
        label.className = 'cover-option-label';
        label.textContent = candidate.label || `Option ${index + 1}`;

        option.appendChild(img);
        option.appendChild(label);

        option.addEventListener('click', () => {
          applyCoverArt(id, type, candidate.url);
        });

        grid.appendChild(option);
      });

      // Focus the first option
      const firstOption = grid.querySelector('.cover-option');
      if (firstOption) setTimeout(() => setFocus(firstOption), 50);
    })
    .catch(() => {
      loading.classList.add('hidden');
      grid.innerHTML = '<p class="cover-picker-empty">Failed to fetch cover art. Check your internet connection.</p>';
    });
}

function closeCoverArtPicker() {
  coverPickerModal.classList.remove('active');
  coverPickerTarget = null;
  document.getElementById('cover-picker-grid').innerHTML = '';
  document.getElementById('cover-picker-loading').classList.remove('hidden');

  if (lastFocusedBeforePicker) {
    setFocus(lastFocusedBeforePicker);
    lastFocusedBeforePicker = null;
  } else {
    setFocus(document.getElementById('nav-home'));
  }
}

async function applyCoverArt(id, type, url) {
  const grid = document.getElementById('cover-picker-grid');
  grid.innerHTML = '';
  document.getElementById('cover-picker-loading').classList.remove('hidden');
  document.getElementById('cover-picker-subtitle').textContent = 'Applying cover art...';

  try {
    const response = await fetch('/api/cover-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type, posterUrl: url })
    });

    if (response.ok) {
      const data = await response.json();
      const newSrc = data.poster + '?t=' + Date.now();
      // Update grid cards — handle both cases: img present, or fallback div (previous poster failed)
      document.querySelectorAll(`.media-card[data-id="${id}"]`).forEach(card => {
        const existingImg = card.querySelector('.media-card-img');
        if (existingImg) {
          existingImg.src = newSrc;
        } else {
          // Previous poster failed to load and was replaced by a fallback div; inject a real img now
          const fallback = card.querySelector('.media-card-fallback');
          const newImg = document.createElement('img');
          newImg.className = 'media-card-img';
          newImg.src = newSrc;
          newImg.alt = card.querySelector('.fallback-title')?.textContent || '';
          if (fallback) fallback.replaceWith(newImg);
          else card.prepend(newImg);
        }
      });
      // Update the details modal poster if it's open for the same item
      if (activeModalMedia && activeModalMedia.id === id) {
        document.getElementById('modal-poster').src = newSrc;
      }
      // Also patch library data so future modal opens use the new poster
      const item = type === 'movie'
        ? libraryData.movies.find(m => m.id === id)
        : libraryData.shows.find(s => s.id === id);
      if (item) item.poster = data.poster;
    }
  } catch (err) {
    console.error('Failed to apply cover art:', err);
  } finally {
    closeCoverArtPicker();
  }
}

// ==========================================
// CUSTOM VIDEO PLAYER MODULE
// ==========================================

function setupVideoPlayer() {
  const backBtn = document.getElementById('player-back-btn');
  const playPauseBtn = document.getElementById('player-play-btn');
  const rewindBtn = document.getElementById('player-rewind-btn');
  const forwardBtn = document.getElementById('player-forward-btn');
  const fullscreenBtn = document.getElementById('player-fullscreen-btn');
  const progressContainer = document.getElementById('progress-container');

  backBtn.onclick = stopVideo;
  playPauseBtn.onclick = togglePlayPause;
  rewindBtn.onclick = () => seekVideoDelta(-10);
  forwardBtn.onclick = () => seekVideoDelta(10);
  fullscreenBtn.onclick = toggleFullscreen;
  
  // Progress Bar click/remote click trigger
  progressContainer.onclick = (e) => {
    const rect = progressContainer.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    seekVideoToPercent(percentage);
  };

  // Video element state listeners
  videoElement.addEventListener('timeupdate', updateProgressBar);
  videoElement.addEventListener('loadedmetadata', () => {
    document.getElementById('duration-time').textContent = formatTime(videoElement.duration);
    resetHUDTimer();
  });

  // Listen to video click to play/pause
  videoElement.addEventListener('click', togglePlayPause);
  
  // Activity triggers
  videoPlayerContainer.addEventListener('mousemove', showHUD);
  videoPlayerContainer.addEventListener('click', showHUD);
}

function playVideo(title, filePath) {
  recordWatch(filePath);

  document.getElementById('player-title').textContent = title;
  
  // Stream URL
  const streamUrl = `/api/stream?videoPath=${encodeURIComponent(filePath)}`;
  videoElement.src = streamUrl;
  
  videoPlayerContainer.classList.add('active');
  
  // Hide main page scroll
  document.body.style.overflow = 'hidden';
  
  videoElement.load();
  videoElement.play()
    .then(() => {
      showHUD();
    })
    .catch(error => {
      console.error('Error starting video playback:', error);
      alert('Could not start video playback. Browser may lack codecs for this file format.');
      stopVideo();
    });
}

function recordWatch(filePath) {
  fetch('/api/watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath })
  }).catch(() => {});
}

function stopVideo() {
  videoElement.pause();
  videoElement.src = '';
  
  videoPlayerContainer.classList.remove('active');
  document.body.style.overflow = 'auto';
  
  clearTimeout(hudTimeout);
  
  // Return focus back to detail modal action button
  if (activeModalMedia) {
    if (activeModalMedia.mediaType === 'movie') {
      setFocus(document.getElementById('modal-play-btn'));
    } else {
      // Focus episode list
      const firstEp = document.querySelector('.episode-item');
      if (firstEp) setFocus(firstEp);
      else setFocus(document.getElementById('modal-close'));
    }
  } else {
    setFocus(document.getElementById('nav-home'));
  }
}

function togglePlayPause() {
  const playIcon = document.getElementById('player-play-icon');
  const pauseIcon = document.getElementById('player-pause-icon');
  
  if (videoElement.paused) {
    videoElement.play();
    playIcon.classList.add('hidden');
    pauseIcon.classList.remove('hidden');
  } else {
    videoElement.pause();
    playIcon.classList.remove('hidden');
    pauseIcon.classList.add('hidden');
  }
  resetHUDTimer();
}

function seekVideoDelta(seconds) {
  let newTime = videoElement.currentTime + seconds;
  if (newTime < 0) newTime = 0;
  if (newTime > videoElement.duration) newTime = videoElement.duration;
  videoElement.currentTime = newTime;
  resetHUDTimer();
}

function seekVideoToPercent(percent) {
  if (videoElement.duration) {
    videoElement.currentTime = percent * videoElement.duration;
  }
  resetHUDTimer();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    videoPlayerContainer.requestFullscreen()
      .catch(err => console.error(`Error enabling fullscreen: ${err.message}`));
  } else {
    document.exitFullscreen();
  }
  resetHUDTimer();
}

function updateProgressBar() {
  const filled = document.getElementById('progress-filled');
  const handle = document.getElementById('progress-handle');
  const currentText = document.getElementById('current-time');
  
  if (videoElement.duration) {
    const percentage = (videoElement.currentTime / videoElement.duration) * 100;
    filled.style.width = `${percentage}%`;
    handle.style.left = `${percentage}%`;
    currentText.textContent = formatTime(videoElement.currentTime);
  }
}

function formatTime(seconds) {
  if (isNaN(seconds)) return "00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// HUD Controls visibility overlay manager
function showHUD() {
  const hud = document.getElementById('player-controls');
  hud.classList.remove('hidden');
  
  // Ensure player controls are focusable
  document.querySelectorAll('#player-controls .focusable').forEach(el => {
    el.setAttribute('tabindex', '0');
  });

  // Make sure play btn has class focus if nothing else is focused in player
  const active = document.activeElement;
  if (!active || !active.closest('#player-controls')) {
    setFocus(document.getElementById('player-play-btn'));
  }
  
  resetHUDTimer();
}

function hideHUD() {
  const isPlayerActive = videoPlayerContainer.classList.contains('active');
  if (!isPlayerActive) return;

  const hud = document.getElementById('player-controls');
  hud.classList.add('hidden');

  // Remove focus class from buttons inside HUD
  document.querySelectorAll('#player-controls .focusable').forEach(el => {
    el.classList.remove('focused');
    el.blur();
  });
}

function resetHUDTimer() {
  clearTimeout(hudTimeout);
  
  // Do not hide HUD if video is paused
  if (videoElement.paused) return;
  
  hudTimeout = setTimeout(() => {
    hideHUD();
  }, 4000);
}
