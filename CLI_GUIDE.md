# CLI

Admin commands for managing invitation codes and profiles. All commands are
run from the project root:

```bash
node server/cli.js <command> [args]
```

## Invitation tokens

Two kinds of tokens exist. Most users sign up with a *normal* one-shot token;
a single *special* token is also supported for setups where you want one
shared, reusable code.

### Normal tokens (single-use)

```bash
node server/cli.js token              # generate a new code
node server/cli.js clear-tokens       # discard all pending codes
```

A normal code looks like `%aB3dEf7gH9` (an `%` plus ten alphanumerics) and is
consumed the first time it is used. If profile creation fails after the code
has been consumed (disk error etc.), the server puts the code back so the
user can retry.

### Special token (multi-use)

```bash
node server/cli.js special-token              # generate one
node server/cli.js special-token <code>       # set a specific code
node server/cli.js clear-special-token        # remove it
```

A special code is 12–128 alphanumerics with at least one letter and one
digit. Only one is active at a time; setting a new one overwrites the old.
The code is hashed with PBKDF2 before being stored on disk.

Tokens are persisted in `tokens.json` at the project root.

## Profiles

```bash
node server/cli.js list                       # show all profile dirs
node server/cli.js create <id>                # bypass tokens, create directly
node server/cli.js rename <oldId> <newId>     # move profile/<old> → profile/<new>
node server/cli.js reset <id>                 # delete state files, keep dir
node server/cli.js remove <id>                # rename profile/<id> → profile/<id>_del
```

`reset` wipes `history.json`, `progress.json`, `probehistory.json`,
`config.json`, and `examdrafts.json` (the AI history is preserved). `remove`
keeps a backup directory so it's recoverable; if a backup with the same
suffix already exists it is overwritten.

Profile IDs must match `[a-z0-9_-]{1,40}`, must not be a Windows-reserved
name (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`), and must not
be `guest`.

## File locations

| Path | Contents |
| ---- | -------- |
| `tokens.json` | Pending normal codes + hashed special record |
| `profile/<id>/` | One directory per user |
| `user/server-config.json` | Operator config (libraries, default model, …) |
| `user/pdf-search-index-*.json` | Cached full-text index per library |
