# QED Developer Guide

This application is split mechanically into two isolated concerns passing strict boundaries:

## 1. Local Database Backend (`server/`)
Unlike SQL reliant applications, the system generates dynamic databases natively from parsing physical directories.
- `server/index.js` bootstraps an Express session overlaying Vite HMR.
- `server/catalog.js` maps your `library/` PDF folder hierarchically and tracks metadata.
- `server/storage.js` manages writing local interactions (stars / logs / mastery).
  - **Thread-safe mechanism**: Storage writing chains asynchronous operations through isolated `Promise` locking per-profile to avoid corrupted JSON during `fs.writeFile` overwrites.

## 2. Dynamic Frontend Vue (`src/`)
Vue runs natively avoiding hydration. The user interface applies "Optimistic Updates".
When `api.js` is triggered:
1. Immediately alter localized State (E.g. visually highlight a ★).
2. Fetch Node Express via `X-Profile-ID` contextual user headers.
3. Automatically intercept server changes back into Vue `ref` blocks. If fetch fails, the optimistic update reverts.

## Components Layout
- **Workspaces** (`QuestionWorkspace`, `StatsView`): Handle mode logic, rendering specific dashboard grids.
- **Modals** (`SettingsModal`, `SearchModal`): Floating overlay layouts manipulating global `<App>` contexts via `emit()`.

## Important Rules
- Local `library/` PDFs and `profile/` user tracking must NEVER be committed. Ensure they stay in `.gitignore`.
