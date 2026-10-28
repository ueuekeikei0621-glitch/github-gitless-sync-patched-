// Test harness: a fake GitHub REST API on top of a bare git repo, and a
// "phone" that runs the real GitHub Gitless Sync SyncManager against it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");

const OWNER = "ueuekeikei0621-glitch";
const REPO = "obsidian-";
const BRANCH = "main";
const MANIFEST = ".obsidian/github-sync-metadata.json";

function git(gitDir, args, { input, env } = {}) {
  return execFileSync(
    "git",
    ["--git-dir", gitDir, "--literal-pathspecs", "-c", "core.quotepath=false", ...args],
    { input, env: { ...process.env, ...env }, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] },
  );
}

function response(status, json) {
  const text = JSON.stringify(json);
  return { status, json, text, headers: {}, arrayBuffer: Buffer.from(text).buffer };
}

const AUTHORS = {
  plugin: { name: OWNER, email: "ueuekeikei0621@gmail.com" },
  claude: { name: OWNER, email: "ueuekeikei0621@gmail.com" },
};

function authorEnv({ name, email }) {
  return {
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
  };
}

class FakeGitHub {
  constructor(gitDir) {
    this.gitDir = gitDir;
    this.requests = [];
    this.beforeHeadLookup = null; // test hook, runs once
    this.hooks = []; // [{ key: "POST git/trees", fn }], each runs once
    this.indexFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fakegh-")), "index");
  }

  g(args, opts) { return git(this.gitDir, args, opts); }
  head() { return this.g(["rev-parse", `refs/heads/${BRANCH}`]).toString().trim(); }
  exists(sha) {
    try { return this.g(["cat-file", "-t", sha]).toString().trim() === "blob"; } catch { return false; }
  }

  async handle(req) {
    const url = new URL(req.url);
    const method = (req.method || "GET").toUpperCase();
    const prefix = `/repos/${OWNER}/${REPO}/`;
    if (!url.pathname.startsWith(prefix)) return response(404, { message: "Not Found" });
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    const body = req.body ? JSON.parse(req.body) : undefined;
    this.requests.push(`${method} ${rest}`);
    const hook = this.hooks.find((h) => `${method} ${rest}`.startsWith(h.key));
    if (hook) {
      this.hooks.splice(this.hooks.indexOf(hook), 1);
      await hook.fn();
    }
    const empty = !this.hasBranch();
    if (empty && method === "GET" && (rest.startsWith("git/trees/") || rest.startsWith("git/refs/"))) {
      return response(409, { message: "Git Repository is empty." });
    }
    if (method === "PUT" && rest.startsWith("contents/")) return this.putFile(rest.slice(9), body);
    if (method === "GET" && rest.startsWith("zipball/")) return this.zipball();
    if (method === "GET" && rest.startsWith("git/trees/")) return this.getTree(rest.slice(10));
    if (method === "POST" && rest === "git/trees") return this.createTree(body);
    if (method === "POST" && rest === "git/commits") return this.createCommit(body);
    if (rest === `git/refs/heads/${BRANCH}` && method === "GET") {
      if (this.beforeHeadLookup) {
        const hook = this.beforeHeadLookup;
        this.beforeHeadLookup = null;
        await hook();
      }
      return response(200, { ref: `refs/heads/${BRANCH}`, object: { sha: this.head(), type: "commit" } });
    }
    if (rest === `git/refs/heads/${BRANCH}` && method === "PATCH") return this.updateRef(body);
    if (method === "POST" && rest === "git/blobs") return this.createBlob(body);
    if (method === "GET" && rest.startsWith("git/blobs/")) return this.getBlob(rest.slice(10));
    return response(404, { message: "Not Found" });
  }

  hasBranch() {
    try { this.head(); return true; } catch { return false; }
  }

  // PUT /contents/{path}: creates or replaces one file in its own commit.
  putFile(p, { content, message }) {
    const env = { GIT_INDEX_FILE: this.indexFile };
    const parent = this.hasBranch() ? this.head() : null;
    this.g(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
    const sha = this.g(["hash-object", "-w", "--stdin"], { input: Buffer.from(content, "base64") }).toString().trim();
    this.g(["update-index", "--add", "--cacheinfo", `100644,${sha},${p}`], { env });
    const tree = this.g(["write-tree"], { env }).toString().trim();
    const args = ["commit-tree", tree, "-m", message];
    if (parent) args.push("-p", parent);
    const commit = this.g(args, { env: authorEnv(AUTHORS.plugin) }).toString().trim();
    this.g(["update-ref", `refs/heads/${BRANCH}`, commit]);
    return response(201, { content: { sha }, commit: { sha: commit } });
  }

  // GET /zipball/{ref}: the repository as GitHub zips it, in a top folder.
  zipball() {
    const commit = this.head();
    const data = this.g(["archive", "--format=zip", `--prefix=${OWNER}-${REPO}-${commit.slice(0, 7)}/`, commit]);
    const res = response(200, {});
    res.arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return res;
  }

  getTree(ref) {
    const commit = ref === BRANCH ? this.head() : ref;
    const treeSha = this.g(["rev-parse", `${commit}^{tree}`]).toString().trim();
    const tree = [];
    for (const record of this.g(["ls-tree", "-r", "-t", "-l", "-z", commit]).toString("utf8").split("\0")) {
      if (!record) continue;
      const [meta, p] = record.split("\t");
      const [mode, type, sha, size] = meta.split(/\s+/);
      tree.push({ path: p, mode, type, sha, size: size === "-" ? undefined : Number(size), url: "" });
    }
    return response(200, { sha: treeSha, url: "", tree, truncated: false });
  }

  createTree({ tree, base_tree }) {
    const env = { GIT_INDEX_FILE: this.indexFile };
    this.g(base_tree ? ["read-tree", base_tree] : ["read-tree", "--empty"], { env });
    const records = [];
    for (const item of tree) {
      if (item.sha === null) {
        records.push(`0 ${"0".repeat(40)}\t${item.path}`);
        continue;
      }
      let sha = item.sha;
      if (item.content !== undefined) {
        sha = this.g(["hash-object", "-w", "--stdin"], { input: Buffer.from(item.content, "utf8") }).toString().trim();
      } else if (!this.exists(sha)) {
        return response(422, { message: `tree.sha ${sha} is not a valid blob` });
      }
      records.push(`${item.mode} ${sha}\t${item.path}`);
    }
    this.g(["update-index", "-z", "--index-info"], { env, input: records.join("\0") + "\0" });
    return response(201, { sha: this.g(["write-tree"], { env }).toString().trim() });
  }

  createCommit({ message, tree, parents }) {
    const args = ["commit-tree", tree];
    for (const p of parents) args.push("-p", p);
    args.push("-m", message);
    const sha = this.g(args, { env: authorEnv(AUTHORS.plugin) }).toString().trim();
    return response(201, { sha });
  }

  updateRef({ sha, force }) {
    const current = this.head();
    if (!force) {
      try {
        this.g(["merge-base", "--is-ancestor", current, sha]);
      } catch {
        return response(422, { message: "Update is not a fast forward" });
      }
    }
    this.g(["update-ref", `refs/heads/${BRANCH}`, sha, current]);
    return response(200, { ref: `refs/heads/${BRANCH}`, object: { sha, type: "commit" } });
  }

  createBlob({ content, encoding }) {
    const input = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
    return response(201, { sha: this.g(["hash-object", "-w", "--stdin"], { input }).toString().trim() });
  }

  getBlob(sha) {
    if (!/^[0-9a-f]{40}$/.test(sha) || !this.exists(sha)) return response(404, { message: "Not Found" });
    const data = this.g(["cat-file", "blob", sha]);
    const b64 = data.toString("base64").replace(/.{1,60}/g, "$&\n");
    return response(200, { sha, size: data.length, content: b64, encoding: "base64", url: "", node_id: "" });
  }

  // Runs fn once, just before answering the first request matching key.
  once(key, fn) { this.hooks.push({ key, fn }); }

  // A commit made outside Obsidian (Claude or the GitHub web editor).
  externalCommit({ write = {}, remove = [], message = "Update notes" }) {
    const env = { GIT_INDEX_FILE: this.indexFile };
    const parent = this.head();
    this.g(["read-tree", parent], { env });
    const records = [];
    for (const [p, content] of Object.entries(write)) {
      const input = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
      const sha = this.g(["hash-object", "-w", "--stdin"], { input }).toString().trim();
      records.push(`100644 ${sha}\t${p}`);
    }
    for (const p of remove) records.push(`0 ${"0".repeat(40)}\t${p}`);
    this.g(["update-index", "-z", "--index-info"], { env, input: records.join("\0") + "\0" });
    const tree = this.g(["write-tree"], { env }).toString().trim();
    const sha = this.g(["commit-tree", tree, "-p", parent, "-m", message], { env: authorEnv(AUTHORS.claude) }).toString().trim();
    this.g(["update-ref", `refs/heads/${BRANCH}`, sha, parent]);
    return sha;
  }

  bytes(p, ref = BRANCH) {
    try { return this.g(["show", `${ref}:${p}`]); } catch { return null; }
  }

  file(p, ref = BRANCH) {
    try { return this.g(["show", `${ref}:${p}`]).toString("utf8"); } catch { return null; }
  }

  manifest(ref = BRANCH) { return JSON.parse(this.file(MANIFEST, ref)); }

  blobOf(p, ref = BRANCH) {
    try { return this.g(["rev-parse", `${ref}:${p}`]).toString().trim(); } catch { return null; }
  }

  subjects(n = 5) {
    return this.g(["log", "--format=%s", `-${n}`, BRANCH]).toString().trim().split("\n");
  }
}

const SETTINGS = {
  firstSync: false,
  githubToken: "token",
  githubOwner: OWNER,
  githubRepo: REPO,
  githubBranch: BRANCH,
  syncStrategy: "interval",
  syncInterval: 1,
  syncOnStartup: true,
  syncConfigDir: false,
  conflictHandling: "ask",
  conflictViewMode: "default",
  showStatusBarItem: true,
  showSyncRibbonButton: true,
  showConflictsRibbonButton: true,
  enableLogging: true,
};

// The phone: a vault directory plus the plugin's SyncManager.
class Phone {
  constructor(root) {
    this.root = root;
    this.conflicts = [];
    this.resolve = (conflicts) => conflicts.map((c) => ({ filePath: c.filePath, content: c.localContent }));
    this.logOffset = 0;
  }

  async init(files, metadata) {
    for (const [p, content] of Object.entries(files)) {
      const full = path.join(this.root, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    fs.mkdirSync(path.join(this.root, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(this.root, MANIFEST), JSON.stringify(metadata));
    const SyncManager = require("./plugin")("sync-manager").default;
    const Logger = require("./plugin")("logger").default;
    this.vault = new obsidian.Vault(this.root);
    this.logger = new Logger(this.vault, true);
    await this.logger.init();
    const { DEFAULT_SETTINGS } = require("./plugin")("settings/settings");
    this.settings = Object.assign({}, DEFAULT_SETTINGS, SETTINGS);
    this.manager = new SyncManager(this.vault, this.settings, async (conflicts) => {
      this.conflicts.push(...conflicts);
      return this.resolve(conflicts);
    }, this.logger);
    await this.manager.loadMetadata();
    this.manager.startEventsListener({ registerEvent() {} });
  }

  // Runs one plugin sync and returns its log messages and notices.
  async sync() {
    const notices = obsidian.Notice.messages.length;
    await this.manager.sync();
    await this.vault.flush();
    const log = fs.readFileSync(path.join(this.root, ".obsidian/github-sync.log"), "utf8");
    const entries = log.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const fresh = entries.slice(this.logOffset);
    this.logOffset = entries.length;
    return { log: fresh, notices: obsidian.Notice.messages.slice(notices) };
  }

  async edit(p, content) {
    this.vault.writeFile(p, Buffer.from(content, "utf8"));
    await this.vault.flush();
  }

  async remove(p) {
    await this.vault.adapter.remove(p);
    await this.vault.flush();
  }

  read(p) {
    const full = path.join(this.root, p);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  }

  meta(p) { return this.manager.getFileMetadata(p); }
}

module.exports = { FakeGitHub, Phone, git, MANIFEST, BRANCH };
