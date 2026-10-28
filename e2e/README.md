# End-to-end tests

The tests run the plugin's real sync code, transpiled from `src/`, against a
fake GitHub API backed by a local git repository, with the vault on disk.
`obsidian-mock.js` can behave like iOS, where reading a binary file as text
fails.

They need a clone of a vault repository synced by this plugin and that
repository's auto-fix script (`.github/scripts/sync_autofix.py` in
ueuekeikei0621-glitch/obsidian-).

    pnpm install
    e2e/run.sh <vault clone> <vault clone>/.github/scripts/sync_autofix.py

- `main-test.js`: sync on startup and when returning to the app.
- `first-sync-test.js`: first sync into an empty repository, and on a new device.
- `plugin-scenarios.js`: edits on both sides, conflicts, moves and deletions,
  commits landing during a sync, binary files on iOS, media kept on the device.
- `autofix-scenarios.js`: the auto-fix with the original 1.0.7 plugin, from the
  vault's state before the auto-fix existed:

      git worktree add /tmp/v107 1.0.7
      PLUGIN_BUILD=/tmp/v107-build node e2e/transpile.js /tmp/v107/src
      BASE=30acc7c PLUGIN_BUILD=/tmp/v107-build node e2e/autofix-scenarios.js <vault clone> <sync_autofix.py>
