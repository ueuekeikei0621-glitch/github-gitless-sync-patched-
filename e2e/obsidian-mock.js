// Minimal stand-in for the Obsidian API, enough to run SyncManager on Node.
const fs = require("fs");
const path = require("path");

// Obsidian extends Array.prototype with these.
for (const [name, fn] of Object.entries({
  contains(item) { return this.includes(item); },
  last() { return this[this.length - 1]; },
})) {
  if (!Array.prototype[name]) Object.defineProperty(Array.prototype, name, { value: fn });
}

class TAbstractFile { constructor(p) { this.path = p; } }
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}

function normalizePath(p) {
  p = p.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  return (p === "" ? "/" : p).normalize("NFC");
}

class Notice {
  constructor(message) { Notice.messages.push(String(message)); }
  hide() {}
  setMessage() {}
}
Notice.messages = [];

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function base64ToArrayBuffer(b64) { return toArrayBuffer(Buffer.from(b64, "base64")); }
function arrayBufferToBase64(ab) { return Buffer.from(ab).toString("base64"); }

let handler = null;
function setRequestHandler(fn) { handler = fn; }
async function requestUrl(request) { return handler(request); }

// Vault backed by a directory. Like Obsidian, writes to notes (not to the
// config dir) are reported as vault events a moment later.
class Vault {
  constructor(root) {
    this.root = root;
    this.configDir = ".obsidian";
    this.handlers = {};
    this.pending = [];
    this.onRead = null; // test hook: (path) => void, runs after a read
    this.onReadBinary = null; // same, for binary reads
    this.iosLike = false;
    fs.mkdirSync(path.join(root, this.configDir), { recursive: true });
    const vault = this;
    this.adapter = {
      async read(p) {
        const buf = fs.readFileSync(vault.full(p));
        if (vault.iosLike) {
          // iOS cannot open non-UTF-8 files as text
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(buf);
          } catch {
            throw new Error("The file couldn't be opened because it isn't in the correct format.");
          }
        }
        const text = buf.toString("utf8");
        if (vault.onRead) vault.onRead(normalizePath(p));
        return text;
      },
      async readBinary(p) {
        const data = toArrayBuffer(fs.readFileSync(vault.full(p)));
        if (vault.onReadBinary) vault.onReadBinary(normalizePath(p));
        return data;
      },
      async write(p, data) { vault.writeFile(p, Buffer.from(data, "utf8")); },
      async writeBinary(p, data) { vault.writeFile(p, Buffer.from(data)); },
      async append(p, data) { fs.appendFileSync(vault.full(p), data); },
      async exists(p) { return fs.existsSync(vault.full(p)); },
      async mkdir(p) { fs.mkdirSync(vault.full(p), { recursive: true }); },
      async remove(p) {
        fs.rmSync(vault.full(p));
        vault.emit("delete", new TFile(normalizePath(p)));
      },
      async stat(p) {
        const full = vault.full(p);
        if (!fs.existsSync(full)) return null;
        const st = fs.statSync(full);
        return { type: st.isDirectory() ? "folder" : "file", ctime: Math.floor(st.ctimeMs), mtime: Math.floor(st.mtimeMs), size: st.size };
      },
      async list(p) {
        const dir = vault.full(p);
        const base = normalizePath(p) === "/" ? "" : normalizePath(p) + "/";
        const files = [], folders = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          (entry.isDirectory() ? folders : files).push(base + entry.name);
        }
        return { files, folders };
      },
    };
  }

  full(p) {
    p = normalizePath(p);
    return p === "/" ? this.root : path.join(this.root, p);
  }

  isConfig(p) {
    p = normalizePath(p);
    return p === this.configDir || p.startsWith(this.configDir + "/");
  }

  writeFile(p, buf) {
    const full = this.full(p);
    const existed = fs.existsSync(full);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    this.emit(existed ? "modify" : "create", new TFile(normalizePath(p)));
  }

  emit(name, file) {
    if (this.isConfig(file.path)) return;
    for (const cb of this.handlers[name] || []) {
      this.pending.push(new Promise((resolve) => setTimeout(() => resolve(cb(file)), 5)));
    }
  }

  on(name, cb) {
    (this.handlers[name] ||= []).push(cb);
    return { name, cb };
  }

  async flush() {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  getRoot() { return { path: "/" }; }

  // The file-level API, as much as the plugin uses. Like Obsidian, a TFile
  // follows its file when it's renamed.
  getAbstractFileByPath(p) {
    p = normalizePath(p);
    return fs.existsSync(this.full(p)) && fs.statSync(this.full(p)).isFile() ? this.tfile(p) : null;
  }
  // A TFile with its stat, as Obsidian keeps it
  tfile(p) {
    const file = new TFile(p);
    const st = fs.statSync(this.full(p));
    file.stat = { ctime: Math.floor(st.ctimeMs), mtime: Math.floor(st.mtimeMs), size: st.size };
    return file;
  }
  async readBinary(file) { return this.adapter.readBinary(file.path); }
  async cachedRead(file) { return fs.readFileSync(this.full(file.path), "utf8"); }
  async modifyBinary(file, data) { this.writeFile(file.path, Buffer.from(data)); }
  async process(file, fn) {
    const text = fs.readFileSync(this.full(file.path), "utf8");
    const changed = fn(text);
    if (changed !== text) this.writeFile(file.path, Buffer.from(changed, "utf8"));
    return changed;
  }
  async rename(file, newPath) {
    const oldPath = file.path;
    newPath = normalizePath(newPath);
    if (fs.existsSync(this.full(newPath))) throw new Error("Destination file already exists!");
    fs.mkdirSync(path.dirname(this.full(newPath)), { recursive: true });
    fs.renameSync(this.full(oldPath), this.full(newPath));
    file.path = newPath;
    for (const cb of this.handlers.rename || []) {
      this.pending.push(new Promise((resolve) => setTimeout(() => resolve(cb(new TFile(newPath), oldPath)), 5)));
    }
  }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.path.endsWith(".md")); }

  // Every file of the vault, like Obsidian: hidden files and folders aside.
  getFiles() {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(this.full(dir), { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const rel = dir === "/" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else files.push(this.tfile(normalizePath(rel)));
      }
    };
    walk("/");
    return files;
  }
}

// Just enough of the plugin host to load the plugin's main class.
class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
  async loadData() { return this.app.data ?? null; }
  async saveData(data) { this.app.data = data; }
  registerView() {}
  addSettingTab() {}
  addCommand() {}
  registerEvent() {}
  registerInterval(id) { return id; }
  registerDomEvent(el, type, cb) { el.addEventListener(type, cb); }
  addRibbonIcon() { return { remove() {} }; }
  addStatusBarItem() { return { setText() {}, remove() {} }; }
}
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting {}
class Modal {}

module.exports = {
  Plugin, PluginSettingTab, Setting, Modal,
  TAbstractFile, TFile, TFolder, Vault, Notice, normalizePath,
  base64ToArrayBuffer, arrayBufferToBase64, requestUrl, setRequestHandler,
};
