# Development

A reference for maintainers and contributors. For end-user setup, read
`README.md`.

## Layout

```
server/
  index.js          Express app, route registration, AI orchestration.
  catalog.js        Scans `library/` and produces the question/suite catalog.
  storage.js        Per-profile JSON storage with atomic write + lock.
  search-index.js   Full-text PDF index (lazy, persisted under user/).
  score-parser.js   Extracts score tiers from Lösung PDFs.
  tokens.js         Invitation token store (normal + special hashed token).
  pdfjs.js          Lazy import of the pdfjs-dist legacy build.
  utils.js          Small validation helpers.
  cli.js            `node server/cli.js …` admin commands.
  prompts/          AI system prompts (zh-CN, en, de).

src/
  main.js           Vue app bootstrap.
  router.js         vue-router; route format `/:profile/:mode[@library]`.
  App.vue           Top-level shell, bootstrap, mode switching, exam state.
  components/       Reusable UI (workspaces, modals, sidebar, PDF canvas).
  composables/      `useProfile`, `useLibrary`, `useTheme`, `useI18n`,
                    `useStopwatch`. Most expose a single module-level ref.
  services/api.js   Thin `fetch` wrapper that injects `X-Profile-ID` and
                    `X-Library-ID` headers.
  i18n/messages.js  Translation tables (zh-CN, en-US, de-AT).
  utils/format.js   Pure helpers used by the views.
  changelog/*.json  Per-version changelog entries shown in the update modal.
```

## Frontend ↔ backend contract

The browser sends `X-Profile-ID` (the URL `:profile`) and `X-Library-ID` on
every API call. Server middleware resolves both into `req.storage` and
`req.library`. There is no session cookie; `localStorage` keeps the last-used
profile so the URL can be reconstructed across reloads.

A successful `/api/bootstrap` response is the canonical shape for application
state:

```
{ catalog: { questions, suites, meta },
  state:   { config, progress, history, probeHistory,
             examDrafts, aiMeta, server },
  firstQuestion }
```

`/api/state` returns just the `state` block. The frontend caches `catalog`
client-side per library and uses `/api/state` for profile switches within
the same library, so the question list isn't redownloaded each time.

## Storage

Each profile owns a directory under `profile/<id>/`:

```
config.json         User preferences + AI config.
progress.json       Per-status arrays + per-question attempt log.
history.json        Most-recent attempt per question (deduplicated).
probehistory.json   Per-suite mock-exam results.
examdrafts.json     In-progress exam state (one draft per suite).
aihistory.json      AI conversations (recent ones plain, older ones gzipped).
```

Writes use `tmp + rename` for atomicity and are serialized through
`writeJson`'s per-file Promise lock. `recordAttempt`, `setStar`,
`addProbeResult`, and `updateAiHistory` go through a per-profile lock so
read-modify-write sequences stay consistent.

## Catalog scan

`loadCatalog(projectRoot, libraryRoot)` walks `libraryRoot` once. Results are
held in `catalogCache` (a Map keyed by `<libraryId>-<sha256(path)>`) and
refreshed lazily every `CATALOG_REFRESH_INTERVAL_MS` (default 5 minutes), or
explicitly via `POST /api/catalog/refresh`. Files whose names don't match the
expected pattern are listed in a single `console.warn` at load time, with a
short preview and the expected name templates printed alongside.

## Adding a feature

### A new API endpoint

1. Register the route in `server/index.js`. Use `req.storage` and
   `req.library`. Throw / `next(error)` for unexpected failures so the
   centralized handler returns a generic message.
2. If the endpoint writes user data, decide whether it must be blocked in
   read-only (`isShowcase` or `isGuest`) mode. Add the path to
   `READ_ONLY_BLOCKED_PATHS` if so.
3. Add a thin wrapper in `src/services/api.js`.
4. Wire it into `App.vue` via an existing `applyRemoteState(payload)` call
   when the response includes profile state, or handle it locally otherwise.

### A new translation string

1. Add the key to **all** locale objects in `src/i18n/messages.js`.
2. Reference it as `t('your.key')` from any component using `useI18n()`.

### A new mode (top-nav segment)

1. Add the slug to `VALID_MODES` in `src/router.js`.
2. Add a branch to `switchModeLocal` in `App.vue`.
3. Render the workspace under the existing `mode === '…'` guards in
   `App.vue`'s template.
4. If the mode requires a separate sidebar layout, return its sections from
   the corresponding `*SidebarSections` computed property.

### A new locale

1. Add a translation map in `src/i18n/messages.js` and extend
   `SUPPORTED_LOCALES` / `LOCALE_LABELS`.
2. Add an AI system prompt at `server/prompts/<locale>.txt`.
3. Map the locale in `normalizeLocale()` inside `server/index.js` so the AI
   server picks the right prompt file.

### A new library

Either add an entry under `libraries[]` in `user/server-config.json`, or set
`allowLibrarySwitch: true` and put the library id in the URL
(`/:profile/random@<libraryId>`). A user-visible library switcher lives in the
settings modal.

## Build pipeline

`npm run build` runs `vite build` against `vite.config.js`. The bundle splits
`pdfjs-dist`, the Vue runtime, and the heavier exam/stats workspaces into
their own chunks. The application version displayed in the UI is read from
the running server via `/api/about`; nothing is baked into the bundle.

## Tests

There is no automated test suite yet. Pure helpers worth covering first:

- `server/score-parser.js#parseScoresFromText`
- `server/storage.js#normalizeProgress`, `#normalizeHistory`
- `server/tokens.js#normalizeSpecialSecret`, `#normalizeNormalTokens`
- `server/catalog.js#parseQuestionFile`, `#parseSuiteDirectory`

`vitest` is the recommended runner since `vite` is already in the dependency
tree.

## Things to keep in mind

- Never commit `library/`, `profile/`, `user/`, or `tokens.json`. They are
  in `.gitignore` for a reason.
- The frontend treats `progress`, `history`, etc. as authoritative when the
  server returns them. Always send back the full updated payload from a
  write endpoint so `applyRemoteState` can sync without another round-trip.
- Score-tier and PDF-text caches key on file path + mtime + size; if you
  swap a PDF in place the cache invalidates automatically.
- `server-config.json` is created when missing and otherwise left alone, so
  hand edits survive restarts. Do not write to it from request handlers.
