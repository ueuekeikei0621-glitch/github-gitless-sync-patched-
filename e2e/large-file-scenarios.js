// Files larger than GitHub takes (100 MB) stay on the device that has them,
// and the sync goes on without them.
// Usage: node e2e/large-file-scenarios.js <vault repo> <sync_autofix.py>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, git } = require("./lib");

const [SOURCE_REPO, SCRIPT] = process.argv.slice(2);
const LIMIT = 100 * 1000 * 1000;

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n== ${title}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "large-e2e-"));
const remote = path.join(root, "remote.git");
execFileSync("git", ["clone", "--quiet", "--bare", "--no-tags", SOURCE_REPO, remote]);
const head = execFileSync("git", ["-C", SOURCE_REPO, "rev-parse", process.env.BASE || "origin/main"]).toString().trim();
git(remote, ["update-ref", "refs/heads/main", head]);
git(remote, ["config", "uploadpack.allowFilter", "true"]);
const fake = new FakeGitHub(remote);
obsidian.setRequestHandler((req) => fake.handle(req));
// The vault's own media index lists assets of its real release, which the
// fake doesn't have: start from a repository without one.
if (fake.file(".obsidian/github-sync-media.json") !== null) fake.externalCommit({ remove: [".obsidian/github-sync-media.json"], message: "Start without the media index" });
const work = path.join(root, "work");
execFileSync("git", ["clone", "--quiet", "--filter=blob:none", `file://${remote}`, work]);

function autofix() {
  const out = execFileSync("python3", ["-I", SCRIPT, "--push"], { cwd: work }).toString();
  const lines = out.split("\n").filter(Boolean);
  for (const line of lines) console.log(`        autofix: ${line}`);
  return lines;
}

const noErrors = (r) => !r.notices.some((n) => n.startsWith("Error"));
const said = (r, text) => r.notices.filter((n) => n.includes(text)).length;
const logged = (r, message) => r.log.some((e) => e.message === message);
const same = (a, b) => !!a && !!b && Buffer.compare(a, b) === 0;
const sizeOn = (phone, p) => {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.statSync(full).size : null;
};
const everCommitted = (p) => git(remote, ["log", "--all", "--format=%H", "--", p]).toString().trim() !== "";
// The blob SHA and size of p on GitHub, null if it isn't there
function onGitHub(args) {
  try {
    return git(remote, args).toString().trim();
  } catch {
    return null;
  }
}
const shaOnGitHub = (p) => onGitHub(["rev-parse", `main:${p}`]);
const sizeOnGitHub = (p) => Number(onGitHub(["cat-file", "-s", `main:${p}`]));
function readBytes(phone, p) {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}
async function put(phone, p, data) {
  phone.vault.writeFile(p, data);
  await phone.vault.flush();
}
// A file of size bytes, sparse so that it takes no room, reported to the
// plugin like any new or changed file
async function big(phone, p, size) {
  const full = path.join(phone.root, p);
  const existed = fs.existsSync(full);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const fd = fs.openSync(full, "w");
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  phone.vault.emit(existed ? "modify" : "create", new obsidian.TFile(p));
  await phone.vault.flush();
}

// As on the user's devices: only video and audio are kept off the repository
const DEVICE = { mediaExtensions: "mp4, mov, m4v, webm, mkv, ogv, avi, 3gp, mp3, m4a, wav, aac, ogg, oga, opus, flac" };

async function newPhone(name) {
  const metadata = fake.manifest();
  const files = {};
  for (const [p, entry] of Object.entries(metadata.files)) {
    if (entry.deleted || entry.sha === null || p.split("/").some((s) => s.startsWith("."))) continue;
    files[p] = git(remote, ["cat-file", "blob", entry.sha]);
  }
  const phone = new Phone(path.join(root, name));
  await phone.init(files, metadata);
  Object.assign(phone.settings, DEVICE);
  phone.vault.iosLike = true;
  return phone;
}

async function main() {
  const A = await newPhone("A");
  let r = await A.sync();
  check(noErrors(r), "A syncs today's repository");

  section("1. A PDF over 100 MB stays on the phone");
  const BOOK = "資料/教科書.pdf";
  await big(A, BOOK, LIMIT + 1);
  await A.edit("教科書メモ.md", "![[教科書.pdf]]\n");
  r = await A.sync();
  check(noErrors(r) && fake.file("教科書メモ.md") === "![[教科書.pdf]]\n", "the sync goes on: the note is uploaded");
  check(!everCommitted(BOOK) && !(BOOK in fake.manifest().files), "the PDF isn't uploaded, nor listed in the metadata");
  check(said(r, `Not syncing ${BOOK}: GitHub takes files up to 100 MB. It stays on this device.`) === 1, "A says so, once");
  const head1 = fake.head();
  r = await A.sync();
  check(noErrors(r) && fake.head() === head1 && logged(r, "Nothing to sync"), "the next sync has nothing to do: no empty commit");
  check(said(r, "Not syncing") === 0, "and A doesn't say it again");
  check(sizeOn(A, BOOK) === LIMIT + 1, "the PDF is still on the phone");

  section("2. Another device does without it");
  const B = await newPhone("B");
  r = await B.sync();
  check(noErrors(r) && B.read("教科書メモ.md") === "![[教科書.pdf]]\n" && sizeOn(B, BOOK) === null, "B gets the note, not the PDF");
  check(!logged(r, "Skipped download, file missing from repository"), "and nothing on GitHub points B at the PDF");
  check(autofix().length === 0, "the auto-fix has nothing to do");
  const compressed = Buffer.from("%PDF-1.4 the same book, compressed\n");
  await put(A, BOOK, compressed);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes(BOOK), compressed), "replaced by a smaller file, it's uploaded");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, BOOK), compressed), "and B gets it");

  section("3. Exactly 100 MB still syncs");
  const EXACT = "資料/ちょうど.pdf";
  await big(A, EXACT, LIMIT);
  r = await A.sync();
  check(noErrors(r) && sizeOnGitHub(EXACT) === LIMIT && said(r, "Not syncing") === 0, "uploaded");
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, EXACT) === LIMIT, "B downloads it");
  await A.remove(EXACT);
  r = await A.sync();
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, EXACT) === null && fake.manifest().files[EXACT]?.deleted === true,
    "deleting it on A deletes it on B too");

  section("4. A file on GitHub that grows over 100 MB keeps its old version there");
  const SLIDES = "資料/スライド.pdf";
  const small = Buffer.from("%PDF-1.4 small\n");
  await put(A, SLIDES, small);
  r = await A.sync();
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, SLIDES), small), "B has the small version");
  const head4 = fake.head();
  await big(A, SLIDES, LIMIT + 5);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes(SLIDES), small) && fake.head() === head4, "the big version isn't uploaded, GitHub keeps the old one");
  check(said(r, `Not syncing ${SLIDES}: GitHub takes files up to 100 MB.`) === 1, "A says so");
  await A.edit("別のメモ.md", "別の話\n");
  r = await A.sync();
  check(noErrors(r) && fake.file("別のメモ.md") === "別の話\n" && same(fake.bytes(SLIDES), small), "other changes go up, the old version stays");
  check(fake.manifest().files[SLIDES]?.sha === shaOnGitHub(SLIDES), "and the metadata still matches it");
  check(autofix().length === 0, "the auto-fix has nothing to do");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, SLIDES), small), "B keeps the old version");

  const smaller = Buffer.from("%PDF-1.4 a new, smaller version\n");
  await put(A, SLIDES, smaller);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes(SLIDES), smaller), "back under the limit, it's uploaded");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, SLIDES), smaller), "and B gets it");

  section("5. Everything agrees");
  check(autofix().length === 0, "the auto-fix has nothing to do");
  for (const phone of [A, B]) {
    r = await phone.sync();
    check(noErrors(r) && logged(r, "Nothing to sync"), `${phone === A ? "A" : "B"} has nothing left to sync`);
  }

  section("6. First sync from a vault with a file over 100 MB");
  const root6 = path.join(root, "first");
  const remote6 = path.join(root6, "remote.git");
  fs.mkdirSync(root6, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", remote6]);
  const fake6 = new FakeGitHub(remote6);
  obsidian.setRequestHandler((req) => fake6.handle(req));
  const vaultDir = path.join(root6, "vault");
  fs.mkdirSync(path.join(vaultDir, "資料"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "ノート.md"), "最初のノート\n");
  const fd = fs.openSync(path.join(vaultDir, BOOK), "w");
  fs.ftruncateSync(fd, LIMIT + 1);
  fs.closeSync(fd);
  const SyncManager = require("./plugin")("sync-manager").default;
  const Logger = require("./plugin")("logger").default;
  const { DEFAULT_SETTINGS } = require("./plugin")("settings/settings");
  const vault = new obsidian.Vault(vaultDir);
  vault.iosLike = true;
  const logger = new Logger(vault, true);
  await logger.init();
  const manager = new SyncManager(vault, Object.assign({}, DEFAULT_SETTINGS, DEVICE, {
    githubToken: "t", githubOwner: "ueuekeikei0621-glitch", githubRepo: "obsidian-", githubBranch: "main", firstSync: true,
  }), async () => [], logger);
  await manager.loadMetadata();
  manager.startEventsListener({ registerEvent() {} });
  await vault.flush();
  const notices = obsidian.Notice.messages.length;
  let error = null;
  try {
    await manager.firstSync();
  } catch (err) {
    error = err;
  }
  check(error === null && fake6.file("ノート.md") === "最初のノート\n", `the first sync works (${error})`);
  check(fake6.bytes(BOOK) === null && !(BOOK in fake6.manifest().files), "without the PDF");
  check(obsidian.Notice.messages.slice(notices).some((n) => n.includes(`Not syncing ${BOOK}`)), "and says so");
  obsidian.setRequestHandler((req) => fake.handle(req));

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
