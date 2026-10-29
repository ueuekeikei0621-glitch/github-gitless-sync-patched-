import { Notice, TFile, Vault, normalizePath } from "obsidian";
import GithubClient, { GetTreeResponseItem } from "./github/client";
import Logger from "./logger";
import { GitHubSyncSettings } from "./settings/settings";
import {
  decodeBase64String,
  gitBlobSHA,
  isMediaFile,
  textToArrayBuffer,
} from "./utils";

export const MEDIA_INDEX_FILE_NAME = "github-sync-media.json" as const;
export const MEDIA_STATE_FILE_NAME = "github-sync-media-state.json" as const;
// GitHub serves blobs of up to 100 MB, so a larger file can't go to the
// repository: it goes to the release instead.
export const MAX_REPOSITORY_FILE_SIZE = 100 * 1000 * 1000;

const RELEASE_TAG = "obsidian-media";
const RELEASE_NAME = "Obsidian videos and audio";
const RELEASE_BODY =
  "Videos and audio of the Obsidian vault, synced by GitHub Gitless Sync " +
  "(patched fork). Keep this release a draft and don't delete it or its files.\n\n" +
  "Obsidianの動画と音声の置き場です。下書きのまま残し、消さないでください。";
const DAY = 24 * 60 * 60 * 1000;
// Deleted files stay in the release this long, so they can be brought back.
const TRASH_DAYS = 30;
// Uploads that never made it into the index are removed after this. Long
// enough for every device to put its files back if the index was ever lost.
const ORPHAN_AGE = 7 * DAY;
// A session reuses an asset it uploaded for this long without asking GitHub.
const REUSE_AGE = 60 * 60 * 1000;
// Transfers this big are tracked, so one that kills the app isn't retried forever.
const TRACKED_SIZE = 20 * 1024 * 1024;
const MAX_ATTEMPTS = 2;

const MIME_TYPES: { [extension: string]: string } = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  avi: "video/x-msvideo",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  pdf: "application/pdf",
};

/**
 * A file as the repository lists it.
 */
export interface MediaEntry {
  // Git blob SHA of the content
  sha: string;
  size: number;
  // Id of the release asset holding the content
  asset: number;
  // Name of that asset, `<sha>.<extension>`
  name: string;
  // When it was uploaded
  uploaded: number;
}

/**
 * A deleted file. Devices delete their copy only when they find this record,
 * so a file missing from the index for any other reason is put back instead.
 * Its asset is kept for a while, so the file can be brought back.
 */
export interface TrashEntry extends MediaEntry {
  path: string;
  deletedAt: number;
}

/**
 * The files synced through the release, `.obsidian/github-sync-media.json` in
 * the repository.
 */
export interface MediaIndex {
  version: 1;
  // Release that new assets go to
  release: number | null;
  files: { [path: string]: MediaEntry };
  trash: TrashEntry[];
}

/**
 * A file as this device last synced it.
 */
interface LocalEntry {
  sha: string;
  size: number;
  mtime: number;
}

/**
 * What this device knows, `.obsidian/github-sync-media-state.json`. It's never
 * uploaded.
 */
interface MediaState {
  files: { [path: string]: LocalEntry };
  // Blob SHA of the index as last synced
  indexSha: string | null;
  // The settings of the last sync; a change means another look at everything
  settings: string;
  // A big transfer in progress. Still set at startup if the app died during it.
  pending: { path: string; size: number; attempts: number } | null;
  // Files this device doesn't transfer
  skipped: {
    [path: string]: { size: number; reason: "crashed"; limit: number };
  };
  // Something failed and needs another try
  retry: boolean;
  lastCleanup: number;
}

type LocalFile = { size: number; mtime: number };

type Action =
  | { kind: "download"; path: string; entry: MediaEntry }
  | { kind: "upload"; path: string; file: LocalFile }
  | { kind: "conflict"; path: string; file: LocalFile; remote: MediaEntry }
  | { kind: "remove-remote"; path: string }
  | { kind: "remove-local"; path: string };

function emptyIndex(): MediaIndex {
  return { version: 1, release: null, files: {}, trash: [] };
}

function emptyState(): MediaState {
  return {
    files: {},
    indexSha: null,
    settings: "",
    pending: null,
    skipped: {},
    retry: false,
    lastCleanup: 0,
  };
}

function extensionOf(filePath: string): string {
  const name = filePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9]+$/.test(extension) ? extension : "bin";
}

/**
 * The index as JSON, with paths sorted so that it diffs well.
 */
function serialize(index: MediaIndex): string {
  const sorted = <T>(map: { [key: string]: T }) =>
    Object.keys(map)
      .sort()
      .reduce((acc: { [key: string]: T }, key) => {
        acc[key] = map[key];
        return acc;
      }, {});
  return (
    JSON.stringify(
      {
        version: index.version,
        release: index.release,
        files: sorted(index.files),
        trash: [...index.trash].sort(
          (a, b) => a.deletedAt - b.deletedAt || a.path.localeCompare(b.path),
        ),
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * Syncs large media, video and audio, and any file too large for the
 * repository, through a draft release of the repository instead.
 *
 * The repository only holds the index of those files. Each device compares
 * the index, its own record of the last sync and the files it has, like the
 * notes sync does with the metadata file.
 */
export default class MediaSync {
  // Clock, replaced in tests
  now = () => Date.now();
  private state: MediaState = emptyState();
  // Assets uploaded this session, by name, so a retried round reuses them
  private uploaded = new Map<string, { asset: number; at: number }>();
  private notified = new Set<string>();

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private client: GithubClient,
    private logger: Logger,
    // Whether a photo may still shrink: then it goes to the repository
    private mayShrink: (filePath: string) => boolean = () => false,
  ) {}

  get indexPath() {
    return `${this.vault.configDir}/${MEDIA_INDEX_FILE_NAME}`;
  }

  get statePath() {
    return `${this.vault.configDir}/${MEDIA_STATE_FILE_NAME}`;
  }

  /**
   * Whether filePath is one of this class's own files.
   */
  isInternal(filePath: string): boolean {
    return filePath === this.indexPath || filePath === this.statePath;
  }

  /**
   * Whether filePath syncs through the release: video and audio, and files
   * too large for the repository. The notes sync leaves those files alone,
   * unless the repository has them already.
   */
  manages(filePath: string): boolean {
    if (filePath in this.state.files) {
      return true;
    }
    if (!this.settings.releaseMedia) {
      return false;
    }
    if (isMediaFile(filePath, this.settings.releaseExtensions)) {
      return true;
    }
    const file = this.vault.getAbstractFileByPath(filePath);
    return (
      file instanceof TFile &&
      file.stat.size > MAX_REPOSITORY_FILE_SIZE &&
      !filePath.split("/").some((part) => part.startsWith(".")) &&
      !this.mayShrink(filePath)
    );
  }

  async load() {
    try {
      if (await this.vault.adapter.exists(this.statePath)) {
        this.state = {
          ...emptyState(),
          ...JSON.parse(await this.vault.adapter.read(this.statePath)),
        };
      }
    } catch (err) {
      await this.logger.warn("Media state unreadable, starting over", `${err}`);
      this.state = emptyState();
    }
  }

  private async save() {
    await this.vault.adapter.write(this.statePath, JSON.stringify(this.state));
  }

  /**
   * Forgets what this device synced. Files are compared again on the next
   * sync; nothing is deleted because of it.
   */
  async reset() {
    this.state = emptyState();
    this.uploaded.clear();
    await this.save();
  }

  private limit(): number {
    return this.settings.releaseMaxSizeMB * 1024 * 1024;
  }

  private settingsKey(): string {
    return JSON.stringify([
      this.settings.releaseExtensions,
      this.settings.releaseMaxSizeMB,
      this.settings.downloadReleaseMedia,
    ]);
  }

  /**
   * Shows a message once per session.
   */
  private notify(key: string, message: string) {
    if (!this.notified.has(key)) {
      this.notified.add(key);
      new Notice(message, 10000);
    }
  }

  /**
   * Syncs after the notes did. Failures are shown, logged and retried on the
   * next sync; they never undo the notes sync.
   *
   * @param tree Files of the repository as the notes sync read them
   */
  async sync(tree: { [path: string]: GetTreeResponseItem }) {
    if (!this.settings.releaseMedia) {
      return;
    }
    try {
      await this.checkCrashedTransfer();
      let local = await this.scan(tree);
      for (const [filePath, file] of local) {
        if (file.size > this.limit()) {
          this.notify(
            `too large ${filePath}`,
            `Not syncing ${filePath}: it's larger than ${this.settings.releaseMaxSizeMB} MB.`,
          );
        }
      }
      if (
        !this.state.retry &&
        this.state.settings === this.settingsKey() &&
        (tree[this.indexPath]?.sha ?? null) === this.state.indexSha &&
        !this.hasLocalChanges(local) &&
        this.now() - this.state.lastCleanup < DAY
      ) {
        return;
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await this.round(tree, local)) {
          return;
        }
        local = await this.scan(tree);
      }
      await this.logger.warn("Media sync: the repository kept changing");
      this.state.retry = true;
      await this.save();
    } catch (err) {
      await this.logger.error("Media sync failed", `${err}`);
      this.notify(
        "failed",
        `Videos, audio and large files didn't sync, trying again later. ${err}`,
      );
      this.state.retry = true;
      await this.save().catch(() => {});
    }
  }

  /**
   * A big transfer still marked in progress means the app died during it,
   * most likely out of memory. After MAX_ATTEMPTS the file is left alone.
   */
  private async checkCrashedTransfer() {
    const pending = this.state.pending;
    if (pending === null || pending.attempts < MAX_ATTEMPTS) {
      return;
    }
    this.state.skipped[pending.path] = {
      size: pending.size,
      reason: "crashed",
      limit: this.settings.releaseMaxSizeMB,
    };
    this.state.pending = null;
    await this.save();
    await this.logger.warn("Media sync: gave up on a file", pending);
    this.notify(
      `crashed ${pending.path}`,
      `Not syncing ${pending.path}: it seems too large for this device.`,
    );
  }

  private isSkipped(filePath: string, size: number): boolean {
    const skipped = this.state.skipped[filePath];
    if (skipped === undefined) {
      return false;
    }
    if (
      skipped.size === size &&
      skipped.limit === this.settings.releaseMaxSizeMB
    ) {
      return true;
    }
    // The file or the limit changed: worth another try
    delete this.state.skipped[filePath];
    return false;
  }

  /**
   * The files this class handles on this device.
   */
  private async scan(tree: {
    [path: string]: GetTreeResponseItem;
  }): Promise<Map<string, LocalFile>> {
    const local = new Map<string, LocalFile>();
    for (const file of this.vault.getFiles()) {
      const filePath = file.path;
      if (
        filePath.split("/").some((part) => part.startsWith(".")) ||
        filePath in tree ||
        !this.manages(filePath)
      ) {
        continue;
      }
      const stat = await this.vault.adapter.stat(filePath);
      if (stat && stat.type === "file") {
        local.set(filePath, { size: stat.size, mtime: stat.mtime });
      }
    }
    return local;
  }

  private hasLocalChanges(local: Map<string, LocalFile>): boolean {
    for (const [filePath, file] of local) {
      const known = this.state.files[filePath];
      if (known !== undefined) {
        if (known.size !== file.size || known.mtime !== file.mtime) {
          return true;
        }
      } else if (
        file.size <= this.limit() &&
        !this.isSkipped(filePath, file.size)
      ) {
        return true;
      }
    }
    return Object.keys(this.state.files).some(
      (filePath) => !local.has(filePath),
    );
  }

  private async hash(filePath: string): Promise<string> {
    return await gitBlobSHA(await this.vault.adapter.readBinary(filePath));
  }

  private async readIndex(sha: string): Promise<MediaIndex> {
    const blob = await this.client.getBlob({ sha, retry: true });
    // An unreadable index must stop the sync: read as empty, it would look
    // like every file was deleted.
    const index = JSON.parse(decodeBase64String(blob.content));
    if (
      typeof index !== "object" ||
      typeof index.files !== "object" ||
      index.files === null
    ) {
      throw new Error("The media index is not valid");
    }
    return {
      ...emptyIndex(),
      ...index,
      trash: Array.isArray(index.trash) ? index.trash : [],
    };
  }

  /**
   * One round: read the index, transfer files, commit the new index.
   *
   * @returns false if the branch moved and the round must start over
   */
  private async round(
    tree: { [path: string]: GetTreeResponseItem },
    local: Map<string, LocalFile>,
  ): Promise<boolean> {
    const head = await this.client.getBranchHeadSha({ retry: true });
    const indexSha = await this.client.getFileSha(this.indexPath, head);
    const index =
      indexSha === null ? emptyIndex() : await this.readIndex(indexSha);
    const next: MediaIndex = JSON.parse(JSON.stringify(index));
    // Recorded once the new index is committed
    const synced: { [path: string]: LocalEntry | null } = {};
    let failures = 0;

    const actions = await this.plan(tree, index, local);
    const transfers = actions.filter(
      (a) =>
        a.kind === "download" || a.kind === "upload" || a.kind === "conflict",
    ).length;
    let transfer = 0;
    let progress: Notice | null = null;
    const show = (verb: string, filePath: string, size: number) => {
      transfer++;
      if (size < 1024 * 1024) {
        return;
      }
      const kind = isMediaFile(filePath, this.settings.releaseExtensions)
        ? "Videos and audio"
        : "Large files";
      const message = `${kind} ${transfer}/${transfers}: ${verb} ${filePath.split("/").pop()} (${Math.round(size / 1024 / 1024)} MB)`;
      if (progress === null) {
        progress = new Notice(message, 0);
      } else {
        progress.setMessage(message);
      }
    };

    for (const action of actions) {
      try {
        if (action.kind === "download") {
          show("downloading", action.path, action.entry.size);
          // null: missing on GitHub, which retrying won't change. A new
          // index, once some device uploads it again, brings another try.
          const entry = await this.download(action.entry, action.path);
          if (entry !== null) {
            this.state.files[action.path] = entry;
          }
        } else if (action.kind === "upload") {
          show("uploading", action.path, action.file.size);
          const entry = await this.upload(next, action.path, action.file);
          next.files[action.path] = entry;
          synced[action.path] = {
            sha: entry.sha,
            size: action.file.size,
            mtime: action.file.mtime,
          };
        } else if (action.kind === "conflict") {
          // Both sides changed: the file here wins, the other version is kept
          // next to it.
          show("downloading", action.path, action.remote.size);
          const copyPath = this.copyPath(action.path);
          const copy =
            this.settings.downloadReleaseMedia &&
            action.remote.size <= this.limit()
              ? await this.download(action.remote, copyPath)
              : null;
          if (copy !== null) {
            next.files[copyPath] = { ...action.remote };
            synced[copyPath] = copy;
          } else {
            // Not here: kept in the trash, so it can still be brought back
            next.trash.push({
              ...action.remote,
              path: action.path,
              deletedAt: this.now(),
            });
          }
          show("uploading", action.path, action.file.size);
          const entry = await this.upload(next, action.path, action.file);
          next.files[action.path] = entry;
          synced[action.path] = {
            sha: entry.sha,
            size: action.file.size,
            mtime: action.file.mtime,
          };
        } else if (action.kind === "remove-remote") {
          const entry = next.files[action.path];
          delete next.files[action.path];
          next.trash.push({
            ...entry,
            path: action.path,
            deletedAt: this.now(),
          });
          synced[action.path] = null;
        } else if (action.kind === "remove-local") {
          if (await this.vault.adapter.exists(action.path)) {
            await this.vault.adapter.remove(action.path);
          }
          delete this.state.files[action.path];
        }
      } catch (err) {
        failures++;
        await this.logger.error("Media sync: action failed", {
          action: action.kind,
          path: action.path,
          error: `${err}`,
        });
        this.notify(
          `${action.kind} ${action.path}`,
          `Couldn't sync ${action.path}, trying again later. ${err}`,
        );
      }
    }
    (progress as Notice | null)?.hide();

    // Deleted files whose time in the trash is over. Never in a round that
    // found no index: the files of other devices aren't back in it yet.
    const cleanup =
      indexSha !== null && this.now() - this.state.lastCleanup >= DAY;
    const expired: number[] = [];
    if (cleanup) {
      next.trash = next.trash.filter((entry) => {
        if (this.now() - entry.deletedAt > TRASH_DAYS * DAY) {
          expired.push(entry.asset);
          return false;
        }
        return true;
      });
    }

    let newIndexSha = indexSha;
    const content = serialize(next);
    if (content !== serialize(index)) {
      const treeSha = await this.client.getCommitTreeSha(head);
      const newTree = await this.client.createTree({
        tree: {
          base_tree: treeSha,
          tree: [
            { path: this.indexPath, mode: "100644", type: "blob", content },
          ],
        },
        retry: true,
      });
      const commit = await this.client.createCommit({
        message: "Sync",
        treeSha: newTree,
        parent: head,
        retry: true,
      });
      try {
        await this.client.updateBranchHead({ sha: commit });
      } catch (err) {
        if (err.status === 422) {
          await this.logger.warn("Media sync: branch moved, starting over");
          await this.save();
          return false;
        }
        throw err;
      }
      newIndexSha = await gitBlobSHA(textToArrayBuffer(content));
    }

    for (const [filePath, entry] of Object.entries(synced)) {
      if (entry === null) {
        delete this.state.files[filePath];
      } else {
        this.state.files[filePath] = entry;
      }
    }
    this.state.indexSha = newIndexSha;
    this.state.settings = this.settingsKey();
    this.state.retry = failures > 0;
    await this.save();

    if (cleanup) {
      await this.cleanUp(next, expired);
    }
    if (cleanup || indexSha === null) {
      // Without an index there is nothing to clean up yet
      this.state.lastCleanup = this.now();
      await this.save();
    }
    return true;
  }

  /**
   * Decides what to do with each file, comparing the index, this device's
   * record of the last sync and the files it has.
   */
  private async plan(
    tree: { [path: string]: GetTreeResponseItem },
    index: MediaIndex,
    local: Map<string, LocalFile>,
  ): Promise<Action[]> {
    const actions: Action[] = [];
    const paths = new Set([
      ...Object.keys(index.files),
      ...Object.keys(this.state.files),
      ...local.keys(),
    ]);
    for (const filePath of paths) {
      if (filePath in tree) {
        // In the repository itself: the notes sync handles it
        delete this.state.files[filePath];
        continue;
      }
      const remote: MediaEntry | undefined = index.files[filePath];
      const known: LocalEntry | undefined = this.state.files[filePath];
      const file = local.get(filePath);

      if (file === undefined) {
        if (known === undefined) {
          if (remote !== undefined && this.canDownload(filePath, remote)) {
            actions.push({ kind: "download", path: filePath, entry: remote });
          }
        } else if (remote === undefined) {
          // Gone from both sides
          delete this.state.files[filePath];
        } else if (remote.sha === known.sha) {
          // Deleted here
          actions.push({ kind: "remove-remote", path: filePath });
        } else if (this.canDownload(filePath, remote)) {
          // Changed elsewhere, which wins over the deletion here
          actions.push({ kind: "download", path: filePath, entry: remote });
        } else {
          delete this.state.files[filePath];
        }
        continue;
      }

      if (file.size > this.limit()) {
        this.notify(
          `too large ${filePath}`,
          `Not syncing ${filePath}: it's larger than ${this.settings.releaseMaxSizeMB} MB.`,
        );
        continue;
      }
      if (this.isSkipped(filePath, file.size)) {
        continue;
      }

      let sha: string;
      if (
        known !== undefined &&
        known.size === file.size &&
        known.mtime === file.mtime
      ) {
        sha = known.sha;
      } else {
        sha = await this.hash(filePath);
        if (known !== undefined && sha === known.sha) {
          // Touched, not changed
          known.size = file.size;
          known.mtime = file.mtime;
        }
      }
      const changed = known === undefined || sha !== known.sha;

      if (remote === undefined) {
        if (
          known !== undefined &&
          !changed &&
          index.trash.some((e) => e.path === filePath && e.sha === sha)
        ) {
          // Deleted elsewhere
          actions.push({ kind: "remove-local", path: filePath });
        } else {
          // New here, edited here, or missing from the index: it's put back
          actions.push({ kind: "upload", path: filePath, file });
        }
      } else if (sha === remote.sha) {
        this.state.files[filePath] = {
          sha,
          size: file.size,
          mtime: file.mtime,
        };
      } else if (known === undefined || (changed && remote.sha !== known.sha)) {
        actions.push({ kind: "conflict", path: filePath, file, remote });
      } else if (changed) {
        actions.push({ kind: "upload", path: filePath, file });
      } else if (this.canDownload(filePath, remote)) {
        actions.push({ kind: "download", path: filePath, entry: remote });
      }
    }
    return actions;
  }

  private canDownload(filePath: string, entry: MediaEntry): boolean {
    if (!this.settings.downloadReleaseMedia) {
      return false;
    }
    if (entry.size > this.limit()) {
      this.notify(
        `too large ${filePath}`,
        `Not downloading ${filePath}: it's larger than ${this.settings.releaseMaxSizeMB} MB.`,
      );
      return false;
    }
    return !this.isSkipped(filePath, entry.size);
  }

  /**
   * Runs a transfer, marking it in progress if it's big.
   */
  private async tracked<T>(
    filePath: string,
    size: number,
    transfer: () => Promise<T>,
  ): Promise<T> {
    if (size < TRACKED_SIZE) {
      return await transfer();
    }
    const previous = this.state.pending;
    this.state.pending = {
      path: filePath,
      size,
      attempts:
        previous !== null && previous.path === filePath
          ? previous.attempts + 1
          : 1,
    };
    await this.save();
    try {
      return await transfer();
    } finally {
      this.state.pending = null;
      await this.save();
    }
  }

  /**
   * Downloads a file from the release to filePath.
   *
   * @returns The record of the downloaded file, null if the asset is missing
   * or not what the index says
   */
  private async download(
    entry: MediaEntry,
    filePath: string,
  ): Promise<LocalEntry | null> {
    const data = await this.tracked(filePath, entry.size, () =>
      this.client.downloadReleaseAsset(entry.asset),
    );
    const sha = data === null ? null : await gitBlobSHA(data);
    if (data === null || sha !== entry.sha) {
      await this.logger.warn("Media sync: asset missing or different", {
        filePath,
        entry,
        sha,
      });
      this.notify(
        `missing ${filePath}`,
        `Couldn't download ${filePath}: it's missing on GitHub.`,
      );
      return null;
    }
    const folder = normalizePath(filePath.split("/").slice(0, -1).join("/"));
    if (folder !== "/" && !(await this.vault.adapter.exists(folder))) {
      await this.vault.adapter.mkdir(folder);
    }
    await this.vault.adapter.writeBinary(normalizePath(filePath), data);
    const stat = await this.vault.adapter.stat(normalizePath(filePath));
    return {
      sha,
      size: data.byteLength,
      mtime: stat?.mtime ?? this.now(),
    };
  }

  /**
   * Uploads a file to the release, unless it's there already.
   */
  private async upload(
    next: MediaIndex,
    filePath: string,
    file: LocalFile,
  ): Promise<MediaEntry> {
    return await this.tracked(filePath, file.size, async () => {
      const data = await this.vault.adapter.readBinary(filePath);
      const sha = await gitBlobSHA(data);
      const name = `${sha}.${extensionOf(filePath)}`;
      const entry = (asset: number): MediaEntry => ({
        sha,
        size: data.byteLength,
        asset,
        name,
        uploaded: this.now(),
      });
      // The same content may be in the index already, under another path or
      // in the trash; a moved file is never uploaded again.
      const existing = [...Object.values(next.files), ...next.trash].find(
        (e) => e.name === name,
      );
      if (existing !== undefined) {
        return entry(existing.asset);
      }
      const reused = this.uploaded.get(name);
      if (reused !== undefined && this.now() - reused.at < REUSE_AGE) {
        return entry(reused.asset);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const release = await this.release(next);
        const result = await this.client.uploadReleaseAsset({
          releaseId: release,
          name,
          data,
          contentType:
            MIME_TYPES[extensionOf(filePath)] ?? "application/octet-stream",
        });
        if (result === "no-release") {
          // Deleted on GitHub: make a new one
          next.release = null;
          continue;
        }
        let asset: number;
        if (result === "exists") {
          // Uploaded before, by a round that didn't commit
          const found = (await this.client.listReleaseAssets(release)).find(
            (a) => a.name === name,
          );
          if (found === undefined) {
            throw new Error(`Asset ${name} exists but isn't listed`);
          }
          asset = found.id;
        } else {
          asset = result.id;
        }
        this.uploaded.set(name, { asset, at: this.now() });
        return entry(asset);
      }
      throw new Error("The release keeps disappearing");
    });
  }

  /**
   * The release that new assets go to, created if there's none yet.
   */
  private async release(next: MediaIndex): Promise<number> {
    if (next.release !== null) {
      return next.release;
    }
    const existing = (await this.client.listReleases()).find(
      (r) => r.draft && r.tag_name === RELEASE_TAG,
    );
    next.release =
      existing !== undefined
        ? existing.id
        : await this.client.createDraftRelease({
            tag: RELEASE_TAG,
            name: RELEASE_NAME,
            body: RELEASE_BODY,
          });
    return next.release;
  }

  /**
   * Where the other version of a conflicting file goes, the same name the
   * auto-fix workflow uses for its copies.
   */
  private copyPath(filePath: string): string {
    const slash = filePath.lastIndexOf("/");
    const folder = slash >= 0 ? filePath.slice(0, slash + 1) : "";
    const name = filePath.slice(slash + 1);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    const d = new Date(this.now());
    const pad = (n: number) => `${n}`.padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
    return `${folder}${stem}（GitHub側の版 ${stamp}）${extension}`;
  }

  /**
   * Deletes the assets that left the trash, and uploads that never made it
   * into the index.
   */
  private async cleanUp(index: MediaIndex, expired: number[]) {
    const referenced = new Set<number>();
    const refer = (i: MediaIndex) => {
      for (const e of [...Object.values(i.files), ...i.trash]) {
        referenced.add(e.asset);
      }
    };
    try {
      refer(index);
      // Another device may have just reused one of these assets
      const head = await this.client.getBranchHeadSha({ retry: true });
      const latest = await this.client.getFileSha(this.indexPath, head);
      if (latest !== null) {
        refer(await this.readIndex(latest));
      }
      for (const asset of expired) {
        if (!referenced.has(asset)) {
          await this.client.deleteReleaseAsset(asset);
        }
      }
      if (index.release === null) {
        return;
      }
      for (const asset of await this.client.listReleaseAssets(index.release)) {
        if (
          !referenced.has(asset.id) &&
          this.now() - Date.parse(asset.created_at) > ORPHAN_AGE
        ) {
          await this.client.deleteReleaseAsset(asset.id);
        }
      }
    } catch (err) {
      await this.logger.warn("Media sync: cleanup failed", `${err}`);
    }
  }
}
