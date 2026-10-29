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
  commits landing during a sync, binary files on iOS, media kept on the device,
  a deletion reaching another device.
- `image-scenarios.js`: new photos shrunk before upload, with a stand-in
  encoder: waiting for the note to be saved and left alone, PNG and HEIC
  renamed to .jpg with their links in every form and in canvases, what stays
  untouched, downloaded images, a photo that kills the app, settings.
- `large-file-scenarios.js`: files over GitHub's 100 MB limit stay on the
  device without stopping the sync or making empty commits: new files, a file
  on GitHub that grows over it, exactly 100 MB, the first sync.
- `image-encode-test.js`: the real encoder in headless Chromium (Playwright) on
  images made with ImageMagick and Pillow: EXIF orientation, size limit,
  transparency, quality, bad input. `run.sh` runs it when Playwright is there.
- `media-scenarios.js`: videos and audio synced through a draft release between
  several phones: moves, deletions and the trash, a lost index, failed uploads,
  commits landing during a sync, conflicts, size limits, a transfer that kills
  the app, a new device. With `OLD_BUILD` set to 1.1.0 built by `transpile.js`
  (`node e2e/transpile.js <1.1.0 src> <out dir>`), also a device still on 1.1.0.
- `autofix-scenarios.js`: the auto-fix with the original 1.0.7 plugin, from the
  vault's state before the auto-fix existed:

      git worktree add /tmp/v107 1.0.7
      PLUGIN_BUILD=/tmp/v107-build node e2e/transpile.js /tmp/v107/src
      BASE=30acc7c PLUGIN_BUILD=/tmp/v107-build node e2e/autofix-scenarios.js <vault clone> <sync_autofix.py>
