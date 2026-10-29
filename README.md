# GitHub Gitless Sync (patched fork)

A fork of [GitHub Gitless Sync](https://github.com/silvanocerza/github-gitless-sync)
1.0.7 by Silvano Cerza, fixed for use on an iPhone together with tools that
edit the repository directly, such as Claude or the GitHub web editor.

Install it with [BRAT](https://github.com/TfTHacker/obsidian42-brat) using this
repository's URL. It has the same plugin id, so it replaces the original plugin
and keeps its settings and sync state.

## Changes in 1.4.0 (2026-10-29)

- **Files over 100 MB sync through the release too.** The repository takes
  files of up to 100 MB, so larger ones, a big PDF for instance, now go to
  the draft release like videos, and every device gets them. The release's
  size limit (100 MB by default) and "Download these files from other
  devices" apply to them as well.
  - Once in the release, a file stays there, even made smaller.
  - Photos over 100 MB are shrunk into the repository instead, unless they
    can't be.
  - A file the repository already has keeps its older version there if it
    grows over 100 MB, as before.
  - Devices still on 1.2.0 to 1.3.1 download these files and leave them in
    the release.
- The settings section is now "Videos, audio and large files".

## Changes in 1.3.1 (2026-10-29)

- **Files over 100 MB no longer stop the sync.** GitHub serves files of up to
  100 MB, so a larger file stays on the device that has it, with a notice,
  and everything else syncs as usual. If GitHub has an older version of it,
  that version stays there. Videos and audio keep their own limit.
- **A file deleted on one device is deleted on the others at their next
  sync.** Before, a device kept its unchanged copy until something else
  synced. A copy changed since is still kept and uploaded again.

## Changes in 1.3.0 (2026-10-29)

- **New photos shrink before they're uploaded** (on by default). Photos added
  on the device are scaled to 2500 pixels on the longest side and saved as
  JPEG at 80% quality, usually several times smaller, and the original never
  reaches the repository.
  - PNG, HEIC and other formats become `.jpg` files, and the links to them in
    every note and canvas follow, however they're written. HEIC also becomes
    readable on PCs.
  - Rotated photos come out upright, and location metadata is dropped.
  - A photo is renamed only once it and the notes linking to it have been left
    alone for a minute (three if no note links to it yet), so a note still
    being written is never changed under the editor.
  - Screenshots under 1 MB, GIF and SVG stay as they are, and so does anything
    that can't be decoded or wouldn't shrink by at least a quarter. A photo
    that kills the app twice while it's shrunk, most likely out of memory,
    goes up as it is.
  - Images downloaded from the repository are never touched.
  - Size and quality are settings.
- The settings for videos, audio and photos have their own sections after
  "Conflict handling", which had ended up under the videos section.

## Changes in 1.2.0 (2026-10-29)

- **Videos and audio sync through GitHub Releases** (on by default). Files
  with a video or audio extension are kept in a draft release of the
  repository, named after their content, instead of in the repository itself:
  every device gets them, and they don't count towards the size of the
  repository. The repository holds only their index,
  `.obsidian/github-sync-media.json`.
  - A moved or renamed file is never uploaded again.
  - A device deletes its copy only when the index records the deletion; if the
    index is lost, the devices put their files back into a new one.
  - Deleted files stay in the release for 30 days and can be brought back by
    moving their entry from `trash` back to `files` in the index.
  - When two devices change the same file, the other version is kept next to
    it as `<name>（GitHub側の版 <date>）`.
  - Files larger than the size limit (100 MB by default) stay on the device
    that has them. A transfer that kills the app twice, most likely out of
    memory, isn't tried again until the file or the limit changes.
  - "Download videos and audio from other devices" can be turned off on a
    device short of storage.
  - Notes sync first; a slow or failed media transfer never holds them up.
  - Devices still on 1.1.0 keep working: they ignore the index and leave it
    alone.

## Changes in 1.1.0 (2026-10-29)

- **Changes made outside the plugin are synced.** The plugin compares the
  repository itself with its metadata, so files added, edited or deleted on
  GitHub by other means reach the vault (upstream #45, #53).
- **A commit made during a sync is never reverted.** Each sync is based on the
  branch head it read; if the branch moves before the sync commits, it starts
  over on top of the new commit.
- **Binary files sync on iOS.** Uploads send the file bytes, so images, PDFs
  and other binary files no longer fail with "The file couldn't be opened
  because it isn't in the correct format" (upstream #20), and the recorded SHA
  is always the SHA of what was uploaded.
- **A failed sync can't cost local edits.** Uploads are recorded only after
  GitHub accepts the commit; before, the next sync could download the old
  version over the local file.
- **Moving or deleting files no longer stops syncing.** Notes moved or deleted
  in Obsidian while they changed on GitHub, and files deleted outside Obsidian,
  used to fail every sync with "File does not exist" (upstream #9, #33).
- **New setting: Keep media on this device** (on by default). Images, video,
  audio and PDF created on the device are never uploaded and stay out of the
  remote metadata. Media that are already in the repository sync as usual.
- **Sync on startup works**, and also syncs when you return to the app.
- **"Overwrite local file" conflict handling** now downloads the remote file;
  it used to upload the local one.
- **First sync on a new device** no longer copies hidden folders such as
  `.github` into the vault.
- **Truncated repository listings** stop the sync instead of being taken as
  deletions.

These modifications are distributed under the same AGPL-3.0 license as the
original. The original README follows.

---

# GitHub Gitless Sync

Plugin to sync a GitHub repository with an Obsidian vault.

I highly recommend not using this plugin with another sync service.
This might create problems for this plugin when determining what needs to be synced between remote repository and local vault.

## Features

These are the main features of the plugin:

- Desktop and mobile support
- Doesn't require `git`
- Multiple vaults sync
- Automatic sync on fixed interval
- Manual sync
- Conflict resolution view

- Filtering by file type (TODO 🔨)

## Installation

The plugin is available as a community plugin, you can easily search for it in Obsidian and install it from there.

![Obsidian community plugin settings](./assets/install_instructions.png)

### Issues

If you find any problem please open an issue with as many details as possible.

Please also provide logs if possible, you can copy them from the settings page. Remember to enable logging first.

![Enable logging](./assets/logs_settings.png)

## Usage

### First sync

> [!IMPORTANT]
> The first sync will only work if either the remote repository or the local vault are completely **EMPTY**. If both contain files the first sync will fail.

You must also configure the plugin settings before syncing.

These settings are mandatory:

- Your GitHub Token (see below)
- Repository owner
- Repository name
- Repository branch

If any of this is not set sync won't start.

### Token

A GitHub Fine-grained token is required to sync with your repository. You can create one by clicking [here](https://github.com/settings/personal-access-tokens/new).
The token must have the `Contents` permission set to `Read and write` like in the screenshot below.

![GitHub Fine-grained token](./assets/token_permissions.png)

I also suggest creating the token with access only to your sync repo.

### Sync modes

You can always sync manually by clicking the sync button in the side ribbon.
This will always work even if sync on interval is enabled.

![Sync button](./assets/sync_button.png)

If you don't want to see the button you can hide it, just check the plugin settings.

The `Sync with GitHub` command is also available.

### Conflict resolution

When you sync multiple vaults using this plugin you might risk creating conflicts between the remote and a local vault.
This usually happens when the remote has a new update from vault A, but vault B edits the file before syncing with remote.
That creates a conflict, by default we'll open a view to let you resolve the conflict since you should have all the necessary
information to correctly resolve it.

By default the split view will be used on desktop and the unified one on mobile, you can change the settings to always use the one you prefer.

![Split conflict resolution](./assets/split_diff_view.png)
![Unified conflict resolution](./assets/unified_diff_view.png)

If you don't want to resolve them you can change the settings to always prefer either the remote or local version in case of conflicts.

### Config sync

If you want to sync your vault configs with other vault you can enable that.
It will sync the whole folder, that is `.obsidian` by default, including all plugins and themes.

Note that the `.obsidian` folder will always be present, this happens because the plugin
needs to store some metadata to correctly sync

> [!CAUTION]
> DO NOT sync configs if your remote repository is public.
> That will expose the token you used to sync.

### Reset

If you need to reset the plugin settings and metadata you can easily do that in the settings.

That will completely wipe all the sync metadata so you'll have to repeat the first sync as if you just enabled the plugin for the first time.

## FAQs

### What's different from other sync plugins?

There are obviously other plugins that let you sync your vault with GitHub or other git hosts, like [`obsidian-git`](https://github.com/Vinzent03/obsidian-git) and [`Obsidian-GitHub-Sync`](https://github.com/kevinmkchin/Obsidian-GitHub-Sync) just to name a couple.

Most of those plugins though require the `git` executable to be present in your system, they might rely on Bash scripts too. This makes them much less portable, it's harder to use on Windows, and mobile is really unstable because most of the times they rely on [`isomorphic-git`](https://isomorphic-git.org/).

This annoyed me because I wanted to have the same experience on every platform, and I wanted especially to support mobile.

So I went a different way and chose to sync **only** with GitHub using their REST APIs, this means I don't rely in anyway on `git` being present in your system. This way I can easily support desktop and mobile with the same identical logic, and some small necessary differences in the UI for a better user experience.

This obviously comes with some limitations. Since `git` is not used you can't interact with your repository locally in any way, and any `git` feature like branching, merging, or rebasing, are not available at all.

Also since this relies only on the GitHub APIs you can only sync with GitHub and no other host.

### Can I use this with other sync plugins?

No.

To work correctly this plugin uses a custom metadata file that is updated every time we sync, if you commit changes outside the plugin that file is not updated properly.

Other plugins don't know about that file, so if you sync with others too you risk losing data.

## Contributing

Contributions are obviously accepted.

Bug fixes are always welcome, new feature must be discussed first. Open a [discussion](https://github.com/silvanocerza/github-gitless-sync/discussions) and let's talk in that case.

Keep PRs as small as possible, I won't review PRs with hundreds of lines if it's mostly code.

Low quality or vibe coded PRs are not welcome. Put some effort in it please.

## License

The project is licensed under the [AGPLv3](https://www.gnu.org/licenses/agpl-3.0.en.html) license.
