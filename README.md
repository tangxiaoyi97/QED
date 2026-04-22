# QED

QED is an advanced offline Vue.js application designed to streamline studying. It functions as a rapid workspace where past examination pdfs are loaded instantly through a random drawer, complete with mastery tracking, simulated timer exam modes, and dynamic layout collapsing.

## System Architecture

The project relies natively on local File-System IO allowing lightweight offline usage without database servers:
1. **Frontend**: Vite + Vue 3. UI logic operates independently without frameworks.
2. **Backend**: Express (Node.js). Reads `.pdf` and sets `.json` history objects via atomic locking logic, allowing concurrency safely.

## Directory Structure
- `library/` *(User provided)*: Your massive collection of past papers is to be dropped here. This directory is not tracked by Git but parsed locally by the indexer.
- `profile/` *(Auto generated)*: This holds user-specific `.json` tables for stats, star clicks, and attempts.
- `src/`: Raw UI Vue components.
- `server/`: Backend express app parsing the system.

## Quick Start

1. Install Node.js: Download Node >=20 to process the backend.
2. Install dependencies:
```bash
npm install
```
3. Boot development server:
```bash
npm run dev
```
4. Access via `http://localhost:3000`

## Releasing
For deploying to production bundles:
```bash
npm run build
NODE_ENV=production node server/index.js
```

## Server Config (`user/server-config.json`)

The backend supports read-only showcase mode and multi-library switching:

```json
{
  "version": 2,
  "apiKey": "",
  "defaultModel": "gpt-5.4-mini",
  "showcaseMode": false,
  "allowLibrarySwitch": false,
  "defaultLibrary": "library",
  "libraries": [
    { "id": "library", "label": "Default Library", "path": "library" }
  ]
}
```

- `showcaseMode: true`: disables login, AI, and all user-data write actions globally.
- `allowLibrarySwitch: true`: enables `@library` URL mode tokens (for example `/profile/browse@library`).
- `libraries`: list of allowed libraries (`id`, display `label`, and folder `path`).
- `defaultLibrary`: fallback library when no valid library token is provided.
