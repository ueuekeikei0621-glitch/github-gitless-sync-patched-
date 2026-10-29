import { Notice, TFile, Vault } from "obsidian";
import { EncodedImage, encodeImage } from "./image-encode";
import Logger from "./logger";
import { GitHubSyncSettings } from "./settings/settings";

export const IMAGE_STATE_FILE_NAME = "github-sync-image-state.json" as const;

// Shrunk in place
const JPEG = ["jpg", "jpeg"];
// Shrunk and saved as JPEG, under the same name ending in .jpg
const CONVERTED = ["png", "heic", "heif", "webp", "avif", "bmp", "tif", "tiff"];
// Converted even when that saves nothing: other devices and Claude can't
// always show them
const UNCOMMON = ["heic", "heif", "avif", "tif", "tiff", "bmp"];

const MIME_TYPES: { [extension: string]: string } = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

// PNG this small is mostly screenshots and drawings, best left as they are
const SMALL_PNG = 1024 * 1024;
// Below this, shrinking isn't worth the loss of quality
const SMALL = 300 * 1024;
// A shrunk image replaces the original only if it saves at least a quarter
const MIN_SAVING = 0.75;
// A file this fresh may still be being written
const FRESH = 5 * 1000;
// Converting renames the image and rewrites the links to it, so a new image
// waits until it and the notes linking to it have been left alone for a
// minute, or for three minutes if no note links to it yet.
const QUIET = 60 * 1000;
const UNLINKED_WAIT = 3 * 60 * 1000;
// An image that kills the app twice while it's shrunk, most likely out of
// memory, is left as it is
const MAX_ATTEMPTS = 2;

/**
 * What this device tried, `.obsidian/github-sync-image-state.json`. It's never
 * uploaded.
 */
interface ImageState {
  // Images being shrunk, by path, size and modification time, and how many
  // tries they had. Still there at startup if the app died during one.
  attempts: { [key: string]: number };
}

function extensionOf(filePath: string): string {
  const name = filePath.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function megabytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function samePath(a: string, b: string): boolean {
  return a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
}

/**
 * The vault path of a link target starting with ./ or ../, as written in
 * notePath; null if it leads out of the vault.
 */
function resolveRelative(notePath: string, target: string): string | null {
  const parts = notePath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
    } else if (part !== "." && part !== "") {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/**
 * Whether a link target written in notePath leads to filePath. As in
 * Obsidian, case doesn't matter, and a path is relative to the note (./, ../),
 * from the vault root (/), or the end of the file's path.
 */
function leadsTo(target: string, filePath: string, notePath: string): boolean {
  if (target.startsWith("./") || target.startsWith("../")) {
    const resolved = resolveRelative(notePath, target);
    return resolved !== null && samePath(resolved, filePath);
  }
  if (target.startsWith("/")) {
    return samePath(target.slice(1), filePath);
  }
  const link = target.normalize("NFC").toLowerCase();
  const path = filePath.normalize("NFC").toLowerCase();
  return link.includes("/")
    ? path === link || path.endsWith(`/${link}`)
    : path.split("/").pop() === link;
}

// How a link target is written: in a wikilink, a Markdown link in <>, or a
// plain Markdown link, percent-encoded or not
type Style = "wiki" | "angle" | "encoded" | "plain";

/**
 * Points the links to a renamed image at its new name. Only links change:
 * wikilinks (`![[name]]`, `[[folder/name#x|alias]]`, `[[name\|alias]]` in
 * tables) and Markdown links (`![](name)`, `![](Pasted%20image.png)`,
 * `![](<folder/a b.png>)`).
 *
 * @param oldPath Path before, e.g. "img/Pasted image 1.png"
 * @param newPath Path after, in the same folder, e.g. "img/Pasted image 1.jpg"
 * @param notePath Path of the note the text is from
 */
export function rewriteLinks(
  text: string,
  oldPath: string,
  newPath: string,
  notePath: string,
): string {
  const oldName = oldPath.split("/").pop() as string;
  const newName = newPath.split("/").pop() as string;
  const oldExtension = oldName.slice(oldName.lastIndexOf("."));
  const newExtension = newName.slice(newName.lastIndexOf("."));
  const sameStem =
    oldName.slice(0, -oldExtension.length) ===
    newName.slice(0, -newExtension.length);
  // The new target, null if target doesn't lead to oldPath
  const retarget = (target: string, style: Style): string | null => {
    let decoded = target;
    if (style === "encoded") {
      try {
        decoded = decodeURIComponent(target);
      } catch {
        return null;
      }
    }
    if (!leadsTo(decoded, oldPath, notePath)) {
      return null;
    }
    const slash = target.lastIndexOf("/");
    const name = target.slice(slash + 1);
    let renamed: string;
    if (sameStem) {
      // Keep the link as written, only the extension changes
      renamed = name.slice(0, name.length - oldExtension.length) + newExtension;
    } else if (style === "encoded") {
      renamed = encodeURIComponent(newName);
    } else if (style === "plain") {
      // A space would end the link
      renamed = newName.replace(/ /g, "%20");
    } else {
      renamed = newName;
    }
    return target.slice(0, slash + 1) + renamed;
  };

  text = text.replace(
    /(!?\[\[)([^[\]\n]+?)(\]\])/g,
    (match, open: string, inner: string, close: string) => {
      // The name ends at a heading or an alias; in tables the alias's bar is
      // escaped
      const end = inner.search(/\\\||[|#]/);
      const target = end === -1 ? inner : inner.slice(0, end);
      const renamed = retarget(target, "wiki");
      return renamed === null
        ? match
        : open + renamed + inner.slice(target.length) + close;
    },
  );
  return text.replace(
    /(!?\[[^\]\n]*\]\()(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?\))/g,
    (match, open: string, target: string, close: string) => {
      const bracketed = target.startsWith("<");
      const inner = bracketed ? target.slice(1, -1) : target;
      // Some themes place images with a fragment, like #center
      const hash = inner.indexOf("#");
      const linked = hash === -1 ? inner : inner.slice(0, hash);
      const renamed = retarget(
        linked,
        bracketed ? "angle" : linked.includes("%") ? "encoded" : "plain",
      );
      if (renamed === null) {
        return match;
      }
      const rest = inner.slice(linked.length);
      return (
        open + (bracketed ? `<${renamed}${rest}>` : renamed + rest) + close
      );
    },
  );
}

/**
 * Points a canvas at a renamed image: the cards showing it, and the links in
 * its text cards.
 *
 * @param canvasPath Path of the canvas the text is from
 */
export function rewriteCanvas(
  text: string,
  oldPath: string,
  newPath: string,
  canvasPath: string,
): string {
  let canvas: unknown;
  try {
    canvas = JSON.parse(text);
  } catch {
    return text;
  }
  const nodes = (canvas as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) {
    return text;
  }
  let changed = false;
  for (const node of nodes) {
    if (node === null || typeof node !== "object") {
      continue;
    }
    const card = node as { type?: unknown; file?: unknown; text?: unknown };
    if (
      card.type === "file" &&
      typeof card.file === "string" &&
      samePath(card.file, oldPath)
    ) {
      card.file = newPath;
      changed = true;
    } else if (card.type === "text" && typeof card.text === "string") {
      const rewritten = rewriteLinks(card.text, oldPath, newPath, canvasPath);
      if (rewritten !== card.text) {
        card.text = rewritten;
        changed = true;
      }
    }
  }
  if (!changed) {
    return text;
  }
  // Indented as before; Obsidian uses tabs
  const indent = text.includes("\n\t")
    ? "\t"
    : text.includes("\n  ")
      ? 2
      : undefined;
  return (
    JSON.stringify(canvas, null, indent) + (text.endsWith("\n") ? "\n" : "")
  );
}

/**
 * Shrinks the photos added on this device before they're uploaded, so that
 * they take a fraction of the space in the repository: at most
 * settings.imageMaxSide pixels on the longest side, saved as JPEG.
 */
export default class ImageShrinker {
  // Replaced in tests
  now = () => Date.now();
  encode = encodeImage;
  // New images that wait for a later sync
  private deferred = new Set<string>();
  // Images left as they are, by path, size and modification time
  private kept = new Set<string>();
  private state: ImageState | null = null;
  // The notes and canvases, read once per sync when an image is renamed
  private texts: Map<TFile, string> | null = null;

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private logger: Logger,
  ) {}

  get statePath() {
    return `${this.vault.configDir}/${IMAGE_STATE_FILE_NAME}`;
  }

  /**
   * Whether filePath is this class's own file.
   */
  isInternal(filePath: string): boolean {
    return filePath === this.statePath;
  }

  /**
   * Whether filePath is an image this class may shrink.
   */
  handles(filePath: string): boolean {
    const extension = extensionOf(filePath);
    return (
      (JPEG.includes(extension) || CONVERTED.includes(extension)) &&
      !filePath.split("/").some((part) => part.startsWith("."))
    );
  }

  /**
   * Whether filePath is a new image that must not be uploaded yet.
   */
  isDeferred(filePath: string): boolean {
    return this.deferred.has(filePath);
  }

  /**
   * Shrinks new images. Never throws: an image that can't be shrunk is
   * uploaded as it is.
   *
   * @param candidates Images added on this device and not uploaded yet
   */
  async run(candidates: string[]) {
    this.deferred.clear();
    this.texts = null;
    if (!this.settings.shrinkImages) {
      return;
    }
    await this.forgetAttempts(candidates);
    let shrunk = 0;
    let before = 0;
    let after = 0;
    for (const filePath of candidates) {
      try {
        const result = await this.shrink(filePath);
        if (result === "wait") {
          this.deferred.add(filePath);
        } else if (result !== null) {
          shrunk++;
          before += result.before;
          after += result.after;
        }
      } catch (err) {
        await this.logger.error("Couldn't shrink image", {
          filePath,
          error: `${err}`,
        });
      }
    }
    this.texts = null;
    if (shrunk > 0) {
      new Notice(
        `Photos shrunk: ${shrunk} (${megabytes(before)} → ${megabytes(after)})`,
        8000,
      );
    }
  }

  /**
   * @returns The sizes before and after, "wait" if the image must wait for a
   * later sync, null if it stays as it is
   */
  private async shrink(
    filePath: string,
  ): Promise<{ before: number; after: number } | "wait" | null> {
    if (!this.handles(filePath)) {
      return null;
    }
    const stat = await this.vault.adapter.stat(filePath);
    if (stat === null || stat.type !== "file") {
      return null;
    }
    const key = `${filePath}\n${stat.size}\n${stat.mtime}`;
    if (this.kept.has(key)) {
      return null;
    }
    const extension = extensionOf(filePath);
    const convert = CONVERTED.includes(extension);
    const uncommon = UNCOMMON.includes(extension);
    if (!uncommon && stat.size < (extension === "png" ? SMALL_PNG : SMALL)) {
      this.kept.add(key);
      return null;
    }

    // A copied file can keep an old modification time
    const age = this.now() - Math.max(stat.mtime, stat.ctime);
    if (age < FRESH) {
      return "wait";
    }
    let linking: TFile[] = [];
    if (convert) {
      if (age < QUIET) {
        return "wait";
      }
      linking = await this.filesLinking(filePath);
      if (
        linking.length === 0
          ? age < UNLINKED_WAIT
          : !(await this.leftAlone(linking))
      ) {
        return "wait";
      }
    }

    const file = this.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return null;
    }
    const state = await this.loadState();
    const attempts = state.attempts[key] ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      this.kept.add(key);
      await this.logger.warn("Gave up shrinking an image", filePath);
      new Notice(
        `Not shrinking ${filePath}: it seems too large for this device.`,
      );
      return null;
    }
    // Saved first, so that the next start knows if the app dies decoding it
    state.attempts[key] = attempts + 1;
    await this.saveState();
    let data: ArrayBuffer;
    let encoded: EncodedImage | null;
    try {
      data = await this.vault.readBinary(file);
      encoded = await this.encode(
        data,
        MIME_TYPES[extension],
        this.settings.imageMaxSide,
        this.settings.imageQuality,
      );
    } finally {
      delete state.attempts[key];
      await this.saveState();
    }
    if (encoded === null) {
      await this.logger.info("Image can't be shrunk on this device", filePath);
      this.kept.add(key);
      return null;
    }
    if (!uncommon && encoded.data.byteLength > data.byteLength * MIN_SAVING) {
      await this.logger.info("Shrinking the image saves too little", filePath);
      this.kept.add(key);
      return null;
    }

    if (!convert) {
      await this.vault.modifyBinary(file, encoded.data);
    } else {
      const newPath = await this.freePath(filePath);
      await this.vault.rename(file, newPath);
      const renamed = this.vault.getAbstractFileByPath(newPath);
      if (!(renamed instanceof TFile)) {
        throw new Error(`${newPath} missing after renaming`);
      }
      await this.vault.modifyBinary(renamed, encoded.data);
      for (const note of linking) {
        const text = await this.vault.process(note, (text) =>
          this.rewrite(note, text, filePath, newPath),
        );
        this.texts?.set(note, text);
      }
    }
    await this.logger.info("Shrunk image", {
      filePath,
      before: data.byteLength,
      after: encoded.data.byteLength,
      width: encoded.width,
      height: encoded.height,
    });
    return { before: data.byteLength, after: encoded.data.byteLength };
  }

  /**
   * text of file, with the links to oldPath pointing at newPath.
   */
  private rewrite(
    file: TFile,
    text: string,
    oldPath: string,
    newPath: string,
  ): string {
    return extensionOf(file.path) === "canvas"
      ? rewriteCanvas(text, oldPath, newPath, file.path)
      : rewriteLinks(text, oldPath, newPath, file.path);
  }

  /**
   * The notes and canvases with a link to filePath.
   */
  private async filesLinking(filePath: string): Promise<TFile[]> {
    if (this.texts === null) {
      this.texts = new Map();
      for (const file of this.vault.getFiles()) {
        const extension = extensionOf(file.path);
        if (extension === "md" || extension === "canvas") {
          this.texts.set(file, await this.vault.cachedRead(file));
        }
      }
    }
    const linking: TFile[] = [];
    for (const [file, text] of this.texts) {
      if (this.rewrite(file, text, filePath, `${filePath}.renamed`) !== text) {
        linking.push(file);
      }
    }
    return linking;
  }

  /**
   * Whether none of these files changed in the last minute: a note still
   * being written may have changes that aren't saved yet.
   */
  private async leftAlone(files: TFile[]): Promise<boolean> {
    for (const file of files) {
      const stat = await this.vault.adapter.stat(file.path);
      if (stat !== null && this.now() - stat.mtime < QUIET) {
        return false;
      }
    }
    return true;
  }

  /**
   * The path of the converted image: the same name ending in .jpg, numbered
   * if that's taken.
   */
  private async freePath(filePath: string): Promise<string> {
    const stem = filePath.slice(0, filePath.lastIndexOf("."));
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? `${stem}.jpg` : `${stem} ${n}.jpg`;
      if (!(await this.vault.adapter.exists(candidate))) {
        return candidate;
      }
    }
  }

  private async loadState(): Promise<ImageState> {
    if (this.state === null) {
      this.state = { attempts: {} };
      try {
        if (await this.vault.adapter.exists(this.statePath)) {
          const saved = JSON.parse(
            await this.vault.adapter.read(this.statePath),
          );
          if (typeof saved?.attempts === "object" && saved.attempts !== null) {
            this.state.attempts = saved.attempts;
          }
        }
      } catch (err) {
        await this.logger.warn(
          "Image state unreadable, starting over",
          `${err}`,
        );
      }
    }
    return this.state;
  }

  private async saveState() {
    await this.vault.adapter.write(this.statePath, JSON.stringify(this.state));
  }

  /**
   * Forgets the tries of the images that are no longer waiting for upload.
   */
  private async forgetAttempts(candidates: string[]) {
    try {
      const state = await this.loadState();
      const waiting = new Set(candidates);
      const done = Object.keys(state.attempts).filter(
        (key) => !waiting.has(key.split("\n")[0]),
      );
      if (done.length > 0) {
        for (const key of done) {
          delete state.attempts[key];
        }
        await this.saveState();
      }
    } catch (err) {
      await this.logger.warn("Couldn't update the image state", `${err}`);
    }
  }
}
