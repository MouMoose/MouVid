# MouVid Agent Instructions

MouVid is a Node.js LAN media server with an Express API and a vanilla JS SPA frontend.

## Fast Start

- Install deps: `npm install`
- Run app: `npm start`
- Default URL: `http://localhost:3000`
- No build step and no test suite in this repo.

## Edit And Reload Rules

- Changes in `server.js` require restarting the Node process.
- Changes in `public/` apply on browser refresh.
- Do not hand-edit `library.json`; it is generated and updated by scans/runtime events.
- Keep new code CommonJS-style to match `package.json` (`"type": "commonjs"`).

## Architecture Map

- `server.js`: all backend behavior (API routes, media scan, metadata fetch, stream handling, poster cache).
- `config.json`: persisted settings (`mediaPaths`, `port`, optional API keys).
- `library.json`: persisted catalog (`movies`, `shows`, `watchHistory`).
- `public/app.js`: SPA controller (rendering, polling, navigation, modals, playback wiring).
- `public/style.css`: UI styling.
- `cache/posters/`: downloaded/custom poster files served statically.

## API Surface

- `GET /api/library`: returns catalog + `isScanning` + `scanMessage` (+ recent watch history slice).
- `POST /api/watch`: records a watch event by file path.
- `POST /api/scan`: triggers async rescan.
- `GET /api/settings`, `POST /api/settings`: read/write media paths and API keys.
- `GET /api/test-key`: validates `tmdb` or `omdb` key.
- `GET /api/cover-search`: fetches poster candidates.
- `POST /api/cover-update`: downloads and applies a chosen poster.
- `GET /api/poster`: serves local poster files outside app root.
- `GET /api/stream`: HTTP range streaming for video files.

## Conventions That Matter

- Media parsing supports show markers `S01E02`, `1x02`, and `Season 1 Episode 2`.
- Show title is derived from folder structure (not only filename) to improve reliability.
- IDs are MD5 hashes (`path` for movies/episodes, `showTitle` for shows).
- Scan preserves existing `addedAt`, poster, and genres when possible to avoid metadata churn.
- Poster/genre lookup flow uses OMDB and TMDB (TVMaze fallback for shows) plus local image detection.
- Frontend polls `/api/library` every 3 seconds and only re-renders fully on structural diffs.

## Agent Guardrails

- Prefer minimal, localized changes in `server.js` and `public/app.js`; these files are monolithic and easy to regress.
- Preserve current API response shapes unless the user asks for a contract change.
- When adding endpoints, ensure client-side handling is also updated (or explicitly documented as server-only).
- Avoid introducing heavy frameworks or build tooling unless explicitly requested.
