const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LIBRARY_FILE = path.join(__dirname, 'library.json');
const CACHE_DIR = path.join(__dirname, 'cache');
const POSTERS_DIR = path.join(CACHE_DIR, 'posters');

// Ensure directories exist
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);
if (!fs.existsSync(POSTERS_DIR)) fs.mkdirSync(POSTERS_DIR);

let config = { mediaPaths: ["E:\\Media"], port: PORT, tmdbApiKey: '', omdbApiKey: '' };
let library = { movies: [], shows: [], watchHistory: [] };
let isScanning = false;
let scanMessage = '';

// Load Config
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error("Error reading config.json, using defaults.", e);
    }
  } else {
    saveConfig();
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// Load Library
function loadLibrary() {
  if (fs.existsSync(LIBRARY_FILE)) {
    try {
      library = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
      if (!library.watchHistory) library.watchHistory = [];
    } catch (e) {
      console.error("Error reading library.json, starting empty.", e);
    }
  }
}

function saveLibrary() {
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2), 'utf8');
}

// Helper to get local IP
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Helper to hash strings for IDs and filenames
function getHash(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

// Helper to download files (for online covers)
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Failed to download: Status Code ${res.statusCode}`));
        return;
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        resolve(destPath);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Find local cover arts in directory
function findLocalCover(dirPath, baseNameWithoutExt) {
  const possibleNames = [
    'poster.jpg', 'poster.png', 'cover.jpg', 'cover.png', 'folder.jpg', 'folder.png',
    `${baseNameWithoutExt}.jpg`, `${baseNameWithoutExt}.png`
  ];
  if (!fs.existsSync(dirPath)) return null;
  const files = fs.readdirSync(dirPath);
  for (const name of possibleNames) {
    const match = files.find(f => f.toLowerCase() === name.toLowerCase());
    if (match) {
      return path.join(dirPath, match);
    }
  }
  return null;
}

// Shared JSON fetcher for HTTPS APIs
const httpGetJson = (url) => new Promise((resolve) => {
  https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

// TMDB genre ID -> name maps (stable, hardcoded to avoid extra API calls)
const TMDB_MOVIE_GENRES = {
  28:'Action', 12:'Adventure', 16:'Animation', 35:'Comedy', 80:'Crime',
  99:'Documentary', 18:'Drama', 10751:'Family', 14:'Fantasy', 36:'History',
  27:'Horror', 10402:'Music', 9648:'Mystery', 10749:'Romance', 878:'Sci-Fi',
  10770:'TV Movie', 53:'Thriller', 10752:'War', 37:'Western'
};
const TMDB_TV_GENRES = {
  10759:'Action & Adventure', 16:'Animation', 35:'Comedy', 80:'Crime',
  99:'Documentary', 18:'Drama', 10751:'Family', 10762:'Kids',
  9648:'Mystery', 10763:'News', 10764:'Reality', 10765:'Sci-Fi & Fantasy',
  10766:'Soap', 10767:'Talk', 10768:'War & Politics', 37:'Western'
};

function ensureTmdbConfigured(res) {
  if (!config.tmdbApiKey) {
    res.status(400).json({ error: 'TMDB API key is not configured. Add it in Settings.' });
    return false;
  }
  return true;
}

function parseYear(value) {
  if (!value) return null;
  const year = parseInt(value, 10);
  if (Number.isNaN(year) || year < 1900 || year > 2100) return null;
  return year;
}

function sanitizeDiscoverPage(value) {
  const page = parseInt(value, 10);
  if (Number.isNaN(page) || page < 1) return 1;
  return Math.min(page, 500);
}

function parseBooleanFlag(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function normalizeDiscoverItems(results, type) {
  const genreMap = type === 'movie' ? TMDB_MOVIE_GENRES : TMDB_TV_GENRES;
  return (results || []).map((item) => ({
    tmdbId: item.id,
    type,
    title: type === 'movie' ? item.title : item.name,
    overview: item.overview || '',
    releaseDate: type === 'movie' ? (item.release_date || '') : (item.first_air_date || ''),
    rating: typeof item.vote_average === 'number' ? item.vote_average : null,
    poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '/assets/default-poster.jpg',
    genres: (item.genre_ids || []).map(id => genreMap[id]).filter(Boolean)
  }));
}

function looksExplicitByText(item) {
  const text = `${item?.title || ''} ${item?.name || ''} ${item?.overview || ''}`.toLowerCase();
  const explicitTerms = [
    'nymphomaniac', 'erotic', 'sex', 'sexual', 'porn', 'pornographic',
    'xxx', 'hardcore', 'softcore', 'bdsm', 'fetish', 'orgy', 'nude', 'nudity'
  ];
  return explicitTerms.some(term => text.includes(term));
}

function shouldHideForSafeDiscover(item, includeAdult) {
  if (includeAdult) return false;
  if (item && item.adult === true) return true;
  return looksExplicitByText(item);
}

// Fetch movie poster URL + genres from OMDB → TMDB
async function fetchMovieData(title, year) {
  const cleanTitle = title.trim();
  let url = null;
  let genres = [];

  if (config.omdbApiKey) {
    const yearParam = year ? `&y=${year}` : '';
    const data = await httpGetJson(
      `https://www.omdbapi.com/?t=${encodeURIComponent(cleanTitle)}${yearParam}&type=movie&apikey=${config.omdbApiKey}`
    );
    if (data && data.Response === 'True') {
      if (data.Poster && data.Poster !== 'N/A')
        url = data.Poster.replace(/@\._V1_.*\.jpg$/i, '@._V1_SX600.jpg');
      if (data.Genre && data.Genre !== 'N/A')
        genres = data.Genre.split(',').map(g => g.trim()).filter(Boolean);
      if (url) console.log(`  [Poster/OMDB] "${cleanTitle}" -> "${data.Title}" (${data.Year})`);
    }
  }

  if (config.tmdbApiKey && (!url || !genres.length)) {
    const yearParam = year ? `&year=${year}` : '';
    const data = await httpGetJson(
      `https://api.themoviedb.org/3/search/movie?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(cleanTitle)}${yearParam}`
    );
    if (data && data.results && data.results.length > 0) {
      const best = data.results.find(r => r.poster_path) || data.results[0];
      if (best) {
        if (!url && best.poster_path) {
          url = `https://image.tmdb.org/t/p/w500${best.poster_path}`;
          console.log(`  [Poster/TMDB] "${cleanTitle}" -> "${best.title}"`);
        }
        if (!genres.length && best.genre_ids)
          genres = best.genre_ids.map(id => TMDB_MOVIE_GENRES[id]).filter(Boolean);
      }
    }
  }

  return { url, genres };
}

// Fetch show poster URL + genres from OMDB → TMDB → TVMaze
async function fetchShowData(title) {
  let url = null;
  let genres = [];

  if (config.omdbApiKey) {
    const data = await httpGetJson(
      `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&type=series&apikey=${config.omdbApiKey}`
    );
    if (data && data.Response === 'True') {
      if (data.Poster && data.Poster !== 'N/A')
        url = data.Poster.replace(/@\._V1_.*\.jpg$/i, '@._V1_SX600.jpg');
      if (data.Genre && data.Genre !== 'N/A')
        genres = data.Genre.split(',').map(g => g.trim()).filter(Boolean);
      if (url) console.log(`  [Poster/OMDB] "${title}" -> "${data.Title}"`);
    }
  }

  if (config.tmdbApiKey && (!url || !genres.length)) {
    const data = await httpGetJson(
      `https://api.themoviedb.org/3/search/tv?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(title)}`
    );
    if (data && data.results && data.results.length > 0) {
      const best = data.results.find(r => r.poster_path) || data.results[0];
      if (best) {
        if (!url && best.poster_path) {
          url = `https://image.tmdb.org/t/p/w500${best.poster_path}`;
          console.log(`  [Poster/TMDB] "${title}" -> "${best.name}"`);
        }
        if (!genres.length && best.genre_ids)
          genres = best.genre_ids.map(id => TMDB_TV_GENRES[id]).filter(Boolean);
      }
    }
  }

  if (!url || !genres.length) {
    const json = await httpGetJson(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(title)}`);
    if (json) {
      if (!url && json.image) url = json.image.original || json.image.medium || null;
      if (!genres.length && json.genres) genres = json.genres;
    }
  }

  return { url, genres };
}

// Regex configurations for media file details
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.m4v']);

// Parse file info
function parseFileInfo(filePath) {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) return null;

  const baseName = path.basename(filename, ext);
  
  // Detect TV episode markers: S01E02, 1x02, Season 1 Episode 2
  const tvMatch = baseName.match(/s(\d+)e(\d+)/i) || 
                  baseName.match(/(\d+)x(\d+)/i) || 
                  baseName.match(/season\s*(\d+)\s*episode\s*(\d+)/i);

  if (tvMatch) {
    const seasonNum = parseInt(tvMatch[1], 10);
    const episodeNum = parseInt(tvMatch[2], 10);

    // Derive show title from folder structure — more reliable than filename parsing.
    // If the immediate parent is a "Season XX" folder, step up one more level.
    const immediateParent = path.basename(path.dirname(filePath));
    let showTitle;
    if (/season\s*\d+/i.test(immediateParent)) {
      showTitle = path.basename(path.dirname(path.dirname(filePath)));
    } else {
      showTitle = immediateParent;
    }
    showTitle = showTitle.trim() || "Unknown Series";

    // Extract Episode Title (everything after S01E02)
    let episodeTitle = baseName.substring(tvMatch.index + tvMatch[0].length)
      .replace(/[\.\_\-\(\)\[\]]/g, ' ')
      .replace(/\b(1080p|720p|2160p|4k|bluray|web\-dl|webrip|hdtv|x264|x265|hevc|aac|dts|dd5|5\.1|dual|multi|sub|dub|hdr)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!episodeTitle) episodeTitle = `Episode ${episodeNum}`;

    return {
      type: 'show',
      showTitle: showTitle || "Unknown Series",
      season: seasonNum,
      episode: episodeNum,
      title: episodeTitle,
      path: filePath
    };
  } else {
    // Treat as Movie
    // Look for year: 4 digits starting with 19 or 20
    const yearMatch = baseName.match(/\b(19\d\d|20\d\d)\b/);
    let title = baseName;
    let year = null;

    if (yearMatch) {
      year = parseInt(yearMatch[1], 10);
      const index = baseName.indexOf(yearMatch[1]);
      title = baseName.substring(0, index);
    }

    title = title.replace(/[\.\_\-\(\)\[\]]/g, ' ')
      .replace(/\b(1080p|720p|2160p|4k|bluray|web\-dl|webrip|hdtv|x264|x265|hevc|aac|dts|dd5|5\.1|dual|multi|sub|dub|hdr)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!title) title = baseName;

    return {
      type: 'movie',
      title,
      year,
      path: filePath
    };
  }
}

// Recursive directory scanning
function getFilesRecursively(dir) {
  let results = [];
  if (!fs.existsSync(dir)) {
    console.warn(`Path does not exist: ${dir}`);
    return results;
  }
  
  try {
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFilesRecursively(fullPath));
        } else {
          results.push(fullPath);
        }
      } catch (err) {
        console.error(`Error checking file ${fullPath}`, err);
      }
    });
  } catch (err) {
    console.error(`Error reading directory ${dir}`, err);
  }
  return results;
}

// Media library scan function
async function scanMedia() {
  if (isScanning) return;
  isScanning = true;
  scanMessage = 'Discovering media files…';
  console.log("Starting media scan...");

  const files = [];
  config.mediaPaths.forEach(mediaPath => {
    if (fs.existsSync(mediaPath)) {
      console.log(`Scanning path: ${mediaPath}`);
      files.push(...getFilesRecursively(mediaPath));
    } else {
      console.warn(`Configured path not accessible: ${mediaPath}`);
    }
  });

  const totalFiles = files.length;
  let fileIndex = 0;

  const parsedMovies = [];
  const parsedShowsMap = new Map(); // showTitle -> showObject

  for (const file of files) {
    const info = parseFileInfo(file);
    if (!info) { fileIndex++; continue; }

    fileIndex++;
    const progress = `(${fileIndex}/${totalFiles})`;
    const fileHash = getHash(file);
    
    // Check if we already have this in library to preserve custom assets/metadata
    const existingMovie = library.movies.find(m => m.path === file);
    let existingShow = null;
    let existingEpisode = null;

    if (info.type === 'movie') {
      let posterPath = '';
      scanMessage = `${progress} ${info.title}${info.year ? ' (' + info.year + ')' : ''}`;
      
      // 1. Check local poster
      const localCover = findLocalCover(path.dirname(file), path.basename(file, path.extname(file)));
      const existingGenres = existingMovie && existingMovie.genres && existingMovie.genres.length > 0
        ? existingMovie.genres : null;

      let genres = [];
      if (localCover) {
        posterPath = `/api/poster?localPath=${encodeURIComponent(localCover)}`;
        // Still need genres if missing
        if (!existingGenres) {
          const d = await fetchMovieData(info.title, info.year);
          genres = d.genres;
        } else {
          genres = existingGenres;
        }
      } else if (existingMovie && existingMovie.poster && existingGenres) {
        // Has poster and genres — skip all API calls
        posterPath = existingMovie.poster;
        genres = existingGenres;
      } else {
        // Fetch poster and/or genres from API
        const d = await fetchMovieData(info.title, info.year);
        genres = d.genres;
        if (existingMovie && existingMovie.poster) {
          posterPath = existingMovie.poster;
        } else if (d.url) {
          const cacheFileName = `${getHash(info.title + (info.year || ''))}.jpg`;
          const cacheFilePath = path.join(POSTERS_DIR, cacheFileName);
          try {
            await downloadFile(d.url, cacheFilePath);
            posterPath = `/cache/posters/${cacheFileName}`;
          } catch (err) {
            console.error(`Failed to download poster for ${info.title}:`, err.message);
          }
        }
      }

      parsedMovies.push({
        id: fileHash,
        title: info.title,
        year: info.year,
        path: file,
        poster: posterPath || '/assets/default-poster.jpg',
        genres,
        addedAt: existingMovie ? existingMovie.addedAt : new Date().toISOString()
      });
    } else if (info.type === 'show') {
      const showTitle = info.showTitle;
      scanMessage = `${progress} ${showTitle}`;
      let showObj = parsedShowsMap.get(showTitle);

      if (!showObj) {
        // Look up in existing library
        const existingLibraryShow = library.shows.find(s => s.title === showTitle);
        let posterPath = '';
        const existingGenres = existingLibraryShow && existingLibraryShow.genres && existingLibraryShow.genres.length > 0
          ? existingLibraryShow.genres : null;
        let genres = [];

        // 1. Check local poster (step up past Season folder if needed)
        let showDir = path.dirname(file);
        if (path.basename(showDir).toLowerCase().includes('season')) showDir = path.dirname(showDir);
        const localCover = findLocalCover(showDir, 'poster') || findLocalCover(showDir, showTitle);

        if (localCover) {
          posterPath = `/api/poster?localPath=${encodeURIComponent(localCover)}`;
          if (!existingGenres) {
            const d = await fetchShowData(showTitle);
            genres = d.genres;
          } else {
            genres = existingGenres;
          }
        } else if (existingLibraryShow && existingLibraryShow.poster && existingGenres) {
          // Has everything — skip API
          posterPath = existingLibraryShow.poster;
          genres = existingGenres;
        } else {
          const d = await fetchShowData(showTitle);
          genres = d.genres;
          if (existingLibraryShow && existingLibraryShow.poster) {
            posterPath = existingLibraryShow.poster;
          } else if (d.url) {
            const cacheFileName = `${getHash(showTitle)}.jpg`;
            const cacheFilePath = path.join(POSTERS_DIR, cacheFileName);
            try {
              await downloadFile(d.url, cacheFilePath);
              posterPath = `/cache/posters/${cacheFileName}`;
            } catch (err) {
              console.error(`Failed to download poster for show ${showTitle}:`, err.message);
            }
          }
        }

        showObj = {
          id: getHash(showTitle),
          title: showTitle,
          poster: posterPath || '/assets/default-poster.jpg',
          genres,
          addedAt: existingLibraryShow ? existingLibraryShow.addedAt : new Date().toISOString(),
          seasons: {}
        };
        parsedShowsMap.set(showTitle, showObj);
      }

      if (!showObj.seasons[info.season]) {
        showObj.seasons[info.season] = [];
      }

      // Check if episode already existed
      let existingEp = null;
      const existingLibraryShow = library.shows.find(s => s.title === showTitle);
      if (existingLibraryShow && existingLibraryShow.seasons[info.season]) {
        existingEp = existingLibraryShow.seasons[info.season].find(e => e.path === file);
      }

      showObj.seasons[info.season].push({
        id: fileHash,
        episodeNumber: info.episode,
        seasonNumber: info.season,
        title: info.title,
        path: file,
        addedAt: existingEp ? existingEp.addedAt : new Date().toISOString()
      });
    }
  }

  // Sort episodes in seasons
  parsedShowsMap.forEach((showObj) => {
    Object.keys(showObj.seasons).forEach(seasonKey => {
      showObj.seasons[seasonKey].sort((a, b) => a.episodeNumber - b.episodeNumber);
    });
  });

  library = {
    movies: parsedMovies.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)),
    shows: Array.from(parsedShowsMap.values()).sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)),
    watchHistory: library.watchHistory || []
  };

  saveLibrary();
  isScanning = false;
  scanMessage = '';
  console.log("Media scan completed!");
}

// Load configurations and library on boot
loadConfig();
loadLibrary();

// Scan in background on start (non-blocking)
scanMedia();

// API: Library catalog
app.get('/api/library', (req, res) => {
  res.json({
    ...library,
    watchHistory: (library.watchHistory || []).slice(0, 10),
    isScanning,
    scanMessage
  });
});

// API: Record a watch event
app.post('/api/watch', (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  let entry = null;
  const movie = library.movies.find(m => m.path === filePath);
  if (movie) {
    entry = { id: movie.id, title: movie.title, mediaType: 'movie', poster: movie.poster, watchedAt: new Date().toISOString() };
  } else {
    for (const show of library.shows) {
      let found = false;
      for (const episodes of Object.values(show.seasons || {})) {
        if (episodes.find(e => e.path === filePath)) {
          entry = { id: show.id, title: show.title, mediaType: 'show', poster: show.poster, watchedAt: new Date().toISOString() };
          found = true;
          break;
        }
      }
      if (found) break;
    }
  }

  if (!entry) return res.status(404).json({ error: 'media not found' });

  // Attach genres from current library data
  const libraryItem = entry.mediaType === 'movie'
    ? library.movies.find(m => m.id === entry.id)
    : library.shows.find(s => s.id === entry.id);
  if (libraryItem && libraryItem.genres) entry.genres = libraryItem.genres;

  library.watchHistory = (library.watchHistory || []).filter(w => w.id !== entry.id);
  library.watchHistory.unshift(entry);
  library.watchHistory = library.watchHistory.slice(0, 20);
  saveLibrary();
  res.json({ ok: true });
});

// API: Check scan status / trigger scan
app.post('/api/scan', (req, res) => {
  if (isScanning) {
    return res.status(409).json({ message: "Scan already in progress" });
  }
  scanMedia(); // Trigger asynchronously
  res.json({ message: "Scan started" });
});

// API: Manage settings
app.get('/api/settings', (req, res) => {
  res.json(config);
});

app.post('/api/settings', (req, res) => {
  const { mediaPaths, tmdbApiKey, omdbApiKey } = req.body;
  if (!mediaPaths || !Array.isArray(mediaPaths)) {
    return res.status(400).json({ error: "mediaPaths array is required" });
  }
  config.mediaPaths = mediaPaths;
  if (typeof tmdbApiKey === 'string') config.tmdbApiKey = tmdbApiKey.trim();
  if (typeof omdbApiKey === 'string') config.omdbApiKey = omdbApiKey.trim();
  saveConfig();
  res.json({ message: "Settings saved", config });
});

// API: Poster image handler (to serve local images outside app directory)
app.get('/api/poster', (req, res) => {
  const { localPath } = req.query;
  if (!localPath) {
    return res.status(400).send("localPath query param is required");
  }
  const decodedPath = decodeURIComponent(localPath);
  if (fs.existsSync(decodedPath)) {
    // Get file extension and set correct headers
    const ext = path.extname(decodedPath).toLowerCase();
    let contentType = 'image/jpeg';
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.webp') contentType = 'image/webp';
    
    res.setHeader('Content-Type', contentType);
    fs.createReadStream(decodedPath).pipe(res);
  } else {
    res.status(404).send("Poster not found");
  }
});

// API: HTTP Range Streaming
app.get('/api/stream', (req, res) => {
  const { videoPath } = req.query;
  if (!videoPath) {
    return res.status(400).send("videoPath query parameter is required");
  }

  const decodedPath = decodeURIComponent(videoPath);

  if (!fs.existsSync(decodedPath)) {
    return res.status(404).send("Video file not found");
  }

  let stat;
  try {
    stat = fs.statSync(decodedPath);
  } catch (err) {
    console.error("Error reading file stat", err);
    return res.status(500).send("Internal file system error");
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  // Set file headers based on extension
  const ext = path.extname(decodedPath).toLowerCase();
  let contentType = 'video/mp4';
  if (ext === '.webm') contentType = 'video/webm';
  else if (ext === '.ogg') contentType = 'video/ogg';
  else if (ext === '.mkv') contentType = 'video/x-matroska';

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize) {
      res.status(416).send(`Requested range not satisfiable\n${start} >= ${fileSize}`);
      return;
    }

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(decodedPath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
    };
    res.writeHead(200, head);
    fs.createReadStream(decodedPath).pipe(res);
  }
});

// API: Test an API key for a given provider
app.get('/api/test-key', async (req, res) => {
  const { provider, key } = req.query;
  if (!provider || !key) return res.status(400).json({ error: 'provider and key required' });
  // Validate key contains only safe characters (alphanum, dash, underscore, dot)
  if (!/^[A-Za-z0-9\-_.]{4,100}$/.test(key)) {
    return res.status(400).json({ success: false, message: 'Key contains invalid characters' });
  }

  const fetchJson = (url) => new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  if (provider === 'tmdb') {
    const data = await fetchJson(`https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(key)}`);
    if (data && data.success) return res.json({ success: true, message: 'TMDB key is valid' });
    return res.json({ success: false, message: data?.status_message || 'Invalid TMDB API key' });
  }

  if (provider === 'omdb') {
    // Use a known IMDB ID so the test doesn't depend on title search
    const data = await fetchJson(`https://www.omdbapi.com/?apikey=${encodeURIComponent(key)}&i=tt0111161`);
    if (!data) return res.json({ success: false, message: 'Could not reach OMDB' });
    if (data.Error === 'Invalid API key!') return res.json({ success: false, message: 'Invalid OMDB API key' });
    return res.json({ success: true, message: 'OMDB key is valid' });
  }

  res.status(400).json({ error: 'Unknown provider' });
});

// API: Discover metadata for movies and TV
app.get('/api/discover/genres', (req, res) => {
  if (!ensureTmdbConfigured(res)) return;

  const movies = Object.entries(TMDB_MOVIE_GENRES)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const shows = Object.entries(TMDB_TV_GENRES)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ movies, shows });
});

app.get('/api/discover/movies', async (req, res) => {
  if (!ensureTmdbConfigured(res)) return;

  const allowedSort = new Set(['popularity.desc', 'vote_average.desc', 'primary_release_date.desc', 'primary_release_date.asc']);
  const genre = req.query.genre ? String(req.query.genre) : '';
  const fromYear = parseYear(req.query.fromYear);
  const toYear = parseYear(req.query.toYear);
  const sort = allowedSort.has(req.query.sort) ? req.query.sort : 'popularity.desc';
  const page = sanitizeDiscoverPage(req.query.page);
  const includeAdult = parseBooleanFlag(req.query.includeAdult);

  if (fromYear && toYear && fromYear > toYear) {
    return res.status(400).json({ error: 'fromYear cannot be greater than toYear' });
  }

  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    include_adult: includeAdult ? 'true' : 'false',
    include_video: 'false',
    language: 'en-US',
    sort_by: sort,
    page: String(page)
  });

  if (genre) params.set('with_genres', genre);
  if (fromYear) params.set('primary_release_date.gte', `${fromYear}-01-01`);
  if (toYear) params.set('primary_release_date.lte', `${toYear}-12-31`);

  const data = await httpGetJson(`https://api.themoviedb.org/3/discover/movie?${params.toString()}`);
  if (!data || !Array.isArray(data.results)) {
    return res.status(502).json({ error: 'Failed to fetch discover data from TMDB' });
  }

  const safeResults = data.results.filter(item => !shouldHideForSafeDiscover(item, includeAdult));

  res.json({
    page: data.page || page,
    totalPages: data.total_pages || 0,
    totalResults: data.total_results || 0,
    results: normalizeDiscoverItems(safeResults, 'movie')
  });
});

app.get('/api/discover/shows', async (req, res) => {
  if (!ensureTmdbConfigured(res)) return;

  const allowedSort = new Set(['popularity.desc', 'vote_average.desc', 'first_air_date.desc', 'first_air_date.asc']);
  const genre = req.query.genre ? String(req.query.genre) : '';
  const fromYear = parseYear(req.query.fromYear);
  const toYear = parseYear(req.query.toYear);
  const sort = allowedSort.has(req.query.sort) ? req.query.sort : 'popularity.desc';
  const page = sanitizeDiscoverPage(req.query.page);
  const includeAdult = parseBooleanFlag(req.query.includeAdult);

  if (fromYear && toYear && fromYear > toYear) {
    return res.status(400).json({ error: 'fromYear cannot be greater than toYear' });
  }

  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    include_adult: includeAdult ? 'true' : 'false',
    language: 'en-US',
    sort_by: sort,
    page: String(page)
  });

  if (genre) params.set('with_genres', genre);
  if (fromYear) params.set('first_air_date.gte', `${fromYear}-01-01`);
  if (toYear) params.set('first_air_date.lte', `${toYear}-12-31`);

  const data = await httpGetJson(`https://api.themoviedb.org/3/discover/tv?${params.toString()}`);
  if (!data || !Array.isArray(data.results)) {
    return res.status(502).json({ error: 'Failed to fetch discover data from TMDB' });
  }

  const safeResults = data.results.filter(item => !shouldHideForSafeDiscover(item, includeAdult));

  res.json({
    page: data.page || page,
    totalPages: data.total_pages || 0,
    totalResults: data.total_results || 0,
    results: normalizeDiscoverItems(safeResults, 'show')
  });
});

app.get('/api/discover/search', async (req, res) => {
  if (!ensureTmdbConfigured(res)) return;

  const query = String(req.query.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });

  const type = req.query.type === 'show' ? 'show' : 'movie';
  const page = sanitizeDiscoverPage(req.query.page);
  const includeAdult = parseBooleanFlag(req.query.includeAdult);

  const endpoint = type === 'movie' ? 'search/movie' : 'search/tv';
  const params = new URLSearchParams({
    api_key: config.tmdbApiKey,
    query,
    language: 'en-US',
    page: String(page),
    include_adult: includeAdult ? 'true' : 'false'
  });

  const data = await httpGetJson(`https://api.themoviedb.org/3/${endpoint}?${params.toString()}`);
  if (!data || !Array.isArray(data.results)) {
    return res.status(502).json({ error: 'Failed to fetch search results from TMDB' });
  }

  const safeResults = data.results.filter(item => !shouldHideForSafeDiscover(item, includeAdult));

  res.json({
    page: data.page || page,
    totalPages: data.total_pages || 0,
    totalResults: data.total_results || 0,
    results: normalizeDiscoverItems(safeResults, type)
  });
});

app.get('/api/discover/trailer', async (req, res) => {
  if (!ensureTmdbConfigured(res)) return;

  const tmdbId = parseInt(req.query.tmdbId, 10);
  const type = req.query.type;
  if (Number.isNaN(tmdbId) || tmdbId <= 0) {
    return res.status(400).json({ error: 'tmdbId must be a positive integer' });
  }
  if (type !== 'movie' && type !== 'show') {
    return res.status(400).json({ error: 'type must be movie or show' });
  }

  const endpoint = type === 'movie' ? 'movie' : 'tv';
  const data = await httpGetJson(`https://api.themoviedb.org/3/${endpoint}/${tmdbId}/videos?api_key=${config.tmdbApiKey}&language=en-US`);
  if (!data || !Array.isArray(data.results)) {
    return res.status(502).json({ error: 'Failed to fetch trailer data from TMDB' });
  }

  const candidates = data.results.filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser') && v.key);
  const best = candidates.find(v => v.type === 'Trailer' && v.official) ||
               candidates.find(v => v.type === 'Trailer') ||
               candidates[0] ||
               null;

  if (!best) return res.json({ trailerUrl: null, trailerName: null });

  res.json({
    trailerUrl: `https://www.youtube.com/watch?v=${best.key}`,
    trailerName: best.name || 'Trailer'
  });
});

// API: Search for alternative cover art candidates
app.get('/api/cover-search', async (req, res) => {
  const { id, type } = req.query;
  if (!id || !type) return res.status(400).json({ error: 'id and type are required' });

  let item = null;
  if (type === 'movie') {
    item = library.movies.find(m => m.id === id);
  } else if (type === 'show') {
    item = library.shows.find(s => s.id === id);
  }
  if (!item) return res.status(404).json({ error: 'Item not found in library' });

  const candidates = [];

  // Shared JSON fetcher
  const fetchJson = (url) => new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  if (type === 'movie') {
    // 1. TMDB — best coverage, free API key from themoviedb.org
    if (config.tmdbApiKey) {
      const yearParam = item.year ? `&year=${item.year}` : '';
      const data = await fetchJson(
        `https://api.themoviedb.org/3/search/movie?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(item.title)}${yearParam}`
      );
      if (data && data.results) {
        for (const r of data.results) {
          if (r.poster_path) {
            const year = r.release_date ? r.release_date.split('-')[0] : '';
            candidates.push({
              url: `https://image.tmdb.org/t/p/w500${r.poster_path}`,
              label: `${r.title || ''}${year ? ' (' + year + ')' : ''} — TMDB`
            });
          }
        }
      }
    }

    // 2. OMDB — free API key (1000/day) from omdbapi.com
    if (config.omdbApiKey) {
      const yearParam = item.year ? `&y=${item.year}` : '';
      const data = await fetchJson(
        `https://www.omdbapi.com/?s=${encodeURIComponent(item.title)}${yearParam}&type=movie&apikey=${config.omdbApiKey}`
      );
      if (data && data.Search) {
        for (const r of data.Search) {
          if (r.Poster && r.Poster !== 'N/A') {
            const highRes = r.Poster.replace(/@\._V1_.*\.jpg$/i, '@._V1_SX600.jpg');
            candidates.push({
              url: highRes,
              label: `${r.Title || ''}${r.Year ? ' (' + r.Year + ')' : ''} — OMDB`
            });
          }
        }
      }
    }

  } else {
    // TV Shows
    // 1. TMDB TV — free API key from themoviedb.org
    if (config.tmdbApiKey) {
      const data = await fetchJson(
        `https://api.themoviedb.org/3/search/tv?api_key=${config.tmdbApiKey}&query=${encodeURIComponent(item.title)}`
      );
      if (data && data.results) {
        for (const r of data.results) {
          if (r.poster_path) {
            const year = r.first_air_date ? r.first_air_date.split('-')[0] : '';
            candidates.push({
              url: `https://image.tmdb.org/t/p/w500${r.poster_path}`,
              label: `${r.name || ''}${year ? ' (' + year + ')' : ''} — TMDB`
            });
          }
        }
      }
    }

    // 2. TVMaze — no API key needed
    const tvmazeData = await fetchJson(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(item.title)}`);
    for (const r of (tvmazeData || [])) {
      if (r.show && r.show.image) {
        candidates.push({
          url: r.show.image.original || r.show.image.medium,
          label: `${r.show.name || ''} — TVMaze`
        });
      }
    }
  }

  res.json({ candidates: candidates.filter(c => c.url).slice(0, 20) });
});

// API: Apply a selected cover art poster to a media item
app.post('/api/cover-update', async (req, res) => {
  const { id, type, posterUrl } = req.body;
  if (!id || !type || !posterUrl) {
    return res.status(400).json({ error: 'id, type, and posterUrl are required' });
  }

  // Validate posterUrl is a safe http/https URL
  let parsedUrl;
  try {
    parsedUrl = new URL(posterUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'posterUrl must use http or https' });
    }
  } catch {
    return res.status(400).json({ error: 'posterUrl is not a valid URL' });
  }

  let item = null;
  if (type === 'movie') {
    item = library.movies.find(m => m.id === id);
  } else if (type === 'show') {
    item = library.shows.find(s => s.id === id);
  }
  if (!item) return res.status(404).json({ error: 'Item not found in library' });

  const cacheFileName = `custom_${id}.jpg`;
  const cacheFilePath = path.join(POSTERS_DIR, cacheFileName);
  try {
    await downloadFile(parsedUrl.href, cacheFilePath);
    item.poster = `/cache/posters/${cacheFileName}`;
    saveLibrary();
    res.json({ success: true, poster: item.poster });
  } catch (err) {
    console.error('Failed to download custom poster:', err.message);
    res.status(500).json({ error: 'Failed to download poster image' });
  }
});

// Serve cached images statically
app.use('/cache/posters', express.static(POSTERS_DIR));

// Serve frontend statically
app.use(express.static(path.join(__dirname, 'public')));

// Default client routes fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Boot Server
app.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log(`==================================================`);
  console.log(`   MouVid Media Server is successfully running!    `);
  console.log(`==================================================`);
  console.log(` Local machine:   http://localhost:${PORT}        `);
  console.log(` LAN Access:      http://${localIp}:${PORT}        `);
  console.log(` Media Directory: ${config.mediaPaths.join(', ')} `);
  console.log(`==================================================`);
});
