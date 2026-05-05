# QED

A practice workspace for the Austrian *Standardisierte Reife- und Diplomprüfung*
in Mathematics. The application reads a folder of past-paper PDFs, lets you draw
random questions, mark mastery, run timed mock exams, and (optionally) ask an AI
to explain a question. All user data lives in plain JSON files on disk; there is
no database.

QED targets a desktop browser. There is intentionally no mobile layout.

## Requirements

- Node.js 20 or newer
- One or more directories of past papers in the layout described below

## Quick start

```bash
npm install
npm run dev
```

The dev server starts at `http://localhost:3000`. It serves the Vue frontend
through Vite middleware, so source edits hot-reload.

For a production build:

```bash
npm run build
NODE_ENV=production node server/index.js
```

`PORT` and `HOST` environment variables are honoured. If the requested port is
busy the server will try the next ten ports unless `PORT_RETRY_LIMIT` is set.

## Directory layout

| Path | Tracked in git? | Purpose |
| ---- | --------------- | ------- |
| `library/` | no | PDF question bank (drop your past papers here). |
| `profile/` | no | Per-user JSON state (history, progress, AI chats). Created on first use. |
| `user/server-config.json` | no | Operator config (default model, libraries, showcase mode). Created on first run. |
| `user/pdf-search-index-*.json` | no | Cached full-text index, rebuilt on demand. |
| `tokens.json` | no | Pending invitation codes (managed by the CLI). |
| `defaultprompt.txt` | yes | Optional override for the AI system prompt (zh-CN). |
| `src/` | yes | Vue 3 frontend. |
| `server/` | yes | Express backend, catalog scanner, storage, AI/PDF helpers. |

## Library naming convention

Each suite is one directory under `library/`. The directory name encodes which
*kind* of PDF it holds (question = `au`, solution/Lösung = `lo`):

```
library/
  [au]haupttermin-2024/
    [2024h1]t1-1-ag.pdf
    [2024h1]t1-2-fa.pdf
    ...
    [2024h1]t2-1.pdf
  [lo]haupttermin-2024/
    [2024h1]t1-1-ag.pdf      # solution to the same question id
    ...
```

PDF filenames follow `[<year><term>]t<part>-<num>[-<topic>].pdf` where
`<term>` is `h1`, `n1`, `n2`, `w1`, or `s1`, `<part>` is `1` or `2`, and
`<topic>` (Teil 1 only) is one of `ag`, `fa`, `an`, `ws`. Files that don't
match the pattern are skipped at startup with a warning printed to the
server log.

## Server configuration

`user/server-config.json` is generated on first launch with sensible defaults.
The file is **not** rewritten on subsequent boots, so manual edits are
preserved. Read-time normalization keeps the in-memory copy valid even if the
on-disk file is partially edited. Recognized keys:

```json
{
  "version": 2,
  "apiKey": "",                       // optional server-wide AI key
  "defaultModel": "gpt-5.4-mini",     // model used when a user has no key
  "showcaseMode": false,              // disables login + writes globally
  "allowLibrarySwitch": false,        // enables /:profile/random@<library>
  "defaultLibrary": "library",        // id used when no token is given
  "libraries": [
    { "id": "library", "label": "Default", "path": "library" }
  ]
}
```

Each entry in `libraries[]` may use a relative path (resolved from the project
root) or an absolute path.

## User accounts

User accounts (called *profiles*) are gated behind invitation codes. Generate
one with the CLI and hand it to the user:

```bash
node server/cli.js token
```

The user pastes the code into the in-app registration dialog. See
`CLI_GUIDE.md` for all CLI commands.

Profiles map directly to directories under `profile/` and are referenced by
URL: `http://localhost:3000/<profile>/random`.

## AI integration

If a user (or the operator via `server-config.json`) provides an OpenAI API
key, the AI panel sends the question PDF text together with the system prompt
in `server/prompts/<locale>.txt` (or `defaultprompt.txt` for `zh-CN`) to the
configured model. Conversation history is persisted per profile in
`profile/<id>/aihistory.json`. The seven most recent conversations are kept
fully decompressed; older ones are gzipped in place.

## License

MIT.
