# MouVid — Agent Instructions

**MouVid** is a LAN home media streaming server (Netflix-like UI) built with Express.js and a vanilla JS SPA frontend.

## Running the App

```bash
npm start        # node server.js — serves on http://localhost:3000
```

No build step. No dev dependencies. Changes to `server.js` require a restart; changes to `public/` take effect on browser refresh.

## Architecture

| Layer | Files | Role |
|-------|-------|------|
| Server | `server.js` | Express API + static file serving + media scanning |
| Config | `config.json` | `mediaPaths[]` (directories to scan), `port` |
| Library | `library.json` | Persisted catalog of movies & shows (auto-generated, do not hand-edit) |
| Frontend | `public/app.js` | Single-file SPA controller (~600 lines) |
| Styles | `public/style.css` | Dark Netflix-style theme |
| Poster cache | `cache/posters/` | Downloaded artwork (gitignore-worthy) |

## API Routes (server.js)

- `GET /api/library` — full catalog + scan status
- `POST /api/scan` — trigger async rescan
- `GET /api/settings` / `POST /api/settings` — read/write `config.json`
- `GET /api/stream?videoPath=<abs_path>` — HTTP range streaming (supports resume)
- `GET /api/poster?localPath=<abs_path>` — serve local poster file
- `GET *` — fallback to `index.html` (SPA)

## Key Conventions

**Media filename parsing** (in `server.js`):
- Movies: `Title (Year).ext` → extracts title + year
- TV Shows: `S##E##`, `##x##`, or `Season # Episode #` patterns; release tags (1080p, bluray…) are stripped

**Poster resolution order**:
1. Local files: `poster.jpg`, `cover.png`, `folder.jpg` in media directory
2. `cache/posters/` (previously downloaded)
3. iTunes API (movies, Jaccard token similarity ≥ 45%)
4. TVMaze API (shows)
5. Gradient placeholder (hash-based hue, no network needed)

**IDs**: MD5 hashes of title or file path — stable across rescans.

**State preservation**: `library.json` retains `addedAt` timestamps and poster URLs across rescans to avoid re-fetching.

## Frontend Patterns (public/app.js)

- Polls `/api/library` every **3 seconds**; diffs results before re-rendering
- Renders Netflix-style horizontal rails (Recently Added / Movies / TV Series)
- **Spatial navigation engine**: D-pad / arrow-key controls for TV-remote use; horizontal movement is prioritized within a row
- Modal overlay for media details + episode selector (shows)
- Client-side search filtering
- Settings panel triggers `/api/scan` after saving paths
