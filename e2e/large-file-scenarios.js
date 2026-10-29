// Files larger than the repository takes (100 MB) go to the release, like
// videos; whatever can't go anywhere stays on its device, and the sync goes
// on without it.
// Usage: node e2e/large-file-scenarios.js <vault repo> <sync_autofix.py>
//        PREVIOUS_BUILD=<1.3.1 built by transpile.js> adds a device still on it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, git } = require("./lib");

const [SOURCE_REPO, SCRIPT] = process.argv.slice(2);
const LIMIT = 100 * 1000 * 1000;
const MINUTE = 60 * 1000;

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

const noErrors = (r) => !r.notices.some((n) => n.startsWith("Error") || n.includes("didn't sync"));
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
// What the release index says of p, and the size of its asset
const indexed = (p) => (fake.mediaIndex() || { files: {} }).files[p];
const inRelease = (p, size) => {
  const entry = indexed(p);
  const asset = entry && fake.assets()[entry.asset];
  return !!asset && entry.size === size && asset.data.length === size;
};
const trashed = (p) => (fake.mediaIndex() || { trash: [] }).trash.some((e) => e.path === p);
function readBytes(phone, p) {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}
async function put(phone, p, data) {
  phone.vault.writeFile(p, data);
  await phone.vault.flush();
}
// A file of size bytes, starting with head and sparse after it so that it
// takes no room, reported to the plugin like any new or changed file
async function big(phone, p, size, head = Buffer.alloc(0)) {
  const full = path.join(phone.root, p);
  const existed = fs.existsSync(full);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, head);
  fs.truncateSync(full, size);
  phone.vault.emit(existed ? "modify" : "create", new obsidian.TFile(p));
  await phone.vault.flush();
}
// The photo shrinker's clock, minutes from now
const at = (phone, minutes) => { phone.manager.images.now = () => Date.now() + minutes * MINUTE; };
// Like encodeImage, for "FAKEIMG WxH" stand-ins; null for anything else
async function encode(data, type, maxSide, quality) {
  const m = Buffer.from(data).subarray(0, 40).toString("latin1").match(/^FAKEIMG (\d+)x(\d+)\n/);
  if (!m) return null;
  const scale = Math.min(1, maxSide / Math.max(+m[1], +m[2]));
  const width = Math.round(+m[1] * scale), height = Math.round(+m[2] * scale);
  const out = Buffer.concat([Buffer.from(`FAKEJPG ${width}x${height} q${quality}\n`), Buffer.alloc(500_000, 7)]);
  return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), width, height };
}

// As on the user's devices: only video and audio are kept off the repository
const DEVICE = { mediaExtensions: "mp4, mov, m4v, webm, mkv, ogv, avi, 3gp, mp3, m4a, wav, aac, ogg, oga, opus, flac" };

async function newPhone(name, build) {
  const metadata = fake.manifest();
  const files = {};
  for (const [p, entry] of Object.entries(metadata.files)) {
    if (entry.deleted || entry.sha === null || p.split("/").some((s) => s.startsWith("."))) continue;
    files[p] = git(remote, ["cat-file", "blob", entry.sha]);
  }
  const phone = new Phone(path.join(root, name), build);
  await phone.init(files, metadata);
  Object.assign(phone.settings, DEVICE);
  phone.vault.iosLike = true;
  return phone;
}

async function main() {
  const A = await newPhone("A");
  let r = await A.sync();
  check(noErrors(r), "A syncs today's repository");

  section("1. A PDF over 100 MB goes to the release");
  const BOOK = "資料/教科書.pdf";
  await big(A, BOOK, LIMIT + 1);
  await A.edit("教科書メモ.md", "![[教科書.pdf]]\n");
  r = await A.sync();
  check(noErrors(r) && fake.file("教科書メモ.md") === "![[教科書.pdf]]\n", "the note goes to the repository");
  check(inRelease(BOOK, LIMIT + 1), "the PDF to the release");
  check(!everCommitted(BOOK) && !(BOOK in fake.manifest().files), "and never to the repository or its metadata");
  check(said(r, "Large files 1/1: uploading 教科書.pdf (95 MB)") === 1 && said(r, "Not syncing") === 0,
    `A shows the upload, nothing else (${r.notices.join(" / ")})`);
  const head1 = fake.head();
  r = await A.sync();
  check(noErrors(r) && fake.head() === head1 && logged(r, "Nothing to sync"), "the next sync has nothing to do");

  section("2. Another device gets it");
  const B = await newPhone("B");
  r = await B.sync();
  check(noErrors(r) && B.read("教科書メモ.md") === "![[教科書.pdf]]\n" && sizeOn(B, BOOK) === LIMIT + 1, "B gets the note and the PDF");
  const head2 = fake.head();
  r = await B.sync();
  check(noErrors(r) && fake.head() === head2 && !everCommitted(BOOK) && r.notices.length === 2,
    `and leaves it in the release (${r.notices.join(" / ")})`);
  check(autofix().length === 0, "the auto-fix has nothing to do");

  section("3. Made smaller, it stays in the release");
  const compressed = Buffer.from("%PDF-1.4 the same book, compressed\n");
  await put(A, BOOK, compressed);
  r = await A.sync();
  check(noErrors(r) && inRelease(BOOK, compressed.length) && !everCommitted(BOOK), "the new version replaces it there");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, BOOK), compressed), "and reaches B");
  await big(A, BOOK, LIMIT + 2);
  r = await A.sync();
  r = await B.sync();
  check(noErrors(r) && inRelease(BOOK, LIMIT + 2) && sizeOn(B, BOOK) === LIMIT + 2, "so does a large one again");

  section("4. Deleted on one device, it goes from the others");
  await A.remove(BOOK);
  r = await A.sync();
  check(noErrors(r) && indexed(BOOK) === undefined && trashed(BOOK), "A moves it to the release's trash");
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, BOOK) === null, "B deletes its copy");

  section("5. Exactly 100 MB still goes to the repository");
  const EXACT = "資料/ちょうど.pdf";
  await big(A, EXACT, LIMIT);
  r = await A.sync();
  check(noErrors(r) && sizeOnGitHub(EXACT) === LIMIT && indexed(EXACT) === undefined, "uploaded to the repository");
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, EXACT) === LIMIT, "B downloads it");
  await A.remove(EXACT);
  r = await A.sync();
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, EXACT) === null && fake.manifest().files[EXACT]?.deleted === true,
    "deleting it on A deletes it on B too");

  section("6. Over the release's limit, it stays on the phone");
  const HUGE = "資料/巨大.pdf";
  await big(A, HUGE, 110 * 1000 * 1000);
  r = await A.sync();
  check(noErrors(r) && said(r, `Not syncing ${HUGE}: it's larger than 100 MB.`) === 1 && said(r, "GitHub takes") === 0,
    "A says so, with the limit of the release");
  check(indexed(HUGE) === undefined && !everCommitted(HUGE) && sizeOn(A, HUGE) === 110 * 1000 * 1000, "it's nowhere but on A");
  A.settings.releaseMaxSizeMB = 200;
  r = await A.sync();
  check(noErrors(r) && inRelease(HUGE, 110 * 1000 * 1000), "with a limit of 200 MB, it goes up");
  r = await B.sync();
  check(noErrors(r) && said(r, `Not downloading ${HUGE}: it's larger than 100 MB.`) === 1 && sizeOn(B, HUGE) === null,
    "B, still at 100 MB, doesn't take it");
  B.settings.releaseMaxSizeMB = 200;
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, HUGE) === 110 * 1000 * 1000, "at 200 MB it does");
  await A.remove(HUGE);
  r = await A.sync();
  r = await B.sync();

  section("7. A file on GitHub that grows over 100 MB keeps its old version there");
  const SLIDES = "資料/スライド.pdf";
  const small = Buffer.from("%PDF-1.4 small\n");
  await put(A, SLIDES, small);
  r = await A.sync();
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, SLIDES), small), "B has the small version");
  const head7 = fake.head();
  await big(A, SLIDES, LIMIT + 5);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes(SLIDES), small) && fake.head() === head7 && indexed(SLIDES) === undefined,
    "the big version goes neither to the repository nor to the release");
  check(said(r, `Not syncing ${SLIDES}: GitHub takes files up to 100 MB.`) === 1, "A says so");
  await A.edit("別のメモ.md", "別の話\n");
  r = await A.sync();
  check(noErrors(r) && fake.file("別のメモ.md") === "別の話\n" && same(fake.bytes(SLIDES), small), "other changes go up, the old version stays");
  check(fake.manifest().files[SLIDES]?.sha === shaOnGitHub(SLIDES), "and the metadata still matches it");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, SLIDES), small), "B keeps the old version");
  const smaller = Buffer.from("%PDF-1.4 a new, smaller version\n");
  await put(A, SLIDES, smaller);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes(SLIDES), smaller), "back under the limit, it's uploaded");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, SLIDES), smaller), "and B gets it");

  section("8. A photo over 100 MB is shrunk, not sent to the release");
  const PHOTO = "大きな写真.png";
  A.manager.images.encode = encode;
  at(A, 0);
  await big(A, PHOTO, LIMIT + 10, Buffer.from("FAKEIMG 12000x9000\n"));
  await A.edit("写真メモ.md", `![[${PHOTO}]]\n`);
  r = await A.sync();
  check(noErrors(r) && indexed(PHOTO) === undefined && !everCommitted(PHOTO) && said(r, "Not syncing") === 0,
    "while it waits to be shrunk, it goes nowhere");
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && (fake.file("大きな写真.jpg") || "").startsWith("FAKEJPG 2500x1875 q80") &&
    fake.file("写真メモ.md") === "![[大きな写真.jpg]]\n", "then it's shrunk into the repository");
  check(indexed(PHOTO) === undefined && indexed("大きな写真.jpg") === undefined && !everCommitted(PHOTO), "the original never left A");

  section("9. A photo over 100 MB that can't be shrunk goes to the release");
  const ODD = "読めない写真.png";
  A.manager.images.encode = async () => null;
  at(A, 0);
  await big(A, ODD, LIMIT + 20);
  at(A, 4);
  r = await A.sync();
  check(noErrors(r) && inRelease(ODD, LIMIT + 20) && !everCommitted(ODD) && said(r, "GitHub takes") === 0,
    "once A finds it can't shrink it");
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, ODD) === LIMIT + 20, "and B gets it");
  A.manager.images.encode = encode;
  at(A, 0);
  await A.remove(ODD);
  r = await A.sync();
  r = await B.sync();

  section("10. With the release turned off, a file over 100 MB stays on the phone");
  const OTHER = "資料/別の本.pdf";
  A.settings.releaseMedia = false;
  await big(A, OTHER, LIMIT + 3);
  r = await A.sync();
  check(noErrors(r) && said(r, `Not syncing ${OTHER}: GitHub takes files up to 100 MB. It stays on this device.`) === 1,
    "A says so");
  check(!everCommitted(OTHER) && indexed(OTHER) === undefined && !(OTHER in fake.manifest().files), "it's nowhere but on A");
  const head10 = fake.head();
  r = await A.sync();
  check(noErrors(r) && fake.head() === head10 && said(r, "Not syncing") === 0, "the next sync has nothing to do");
  A.settings.releaseMedia = true;
  r = await A.sync();
  check(noErrors(r) && inRelease(OTHER, LIMIT + 3), "turned back on, the release takes it");
  r = await B.sync();
  check(noErrors(r) && sizeOn(B, OTHER) === LIMIT + 3, "and B gets it");

  section("11. A device still on 1.3.1");
  if (process.env.PREVIOUS_BUILD) {
    const C = await newPhone("C", process.env.PREVIOUS_BUILD);
    r = await C.sync();
    check(noErrors(r) && sizeOn(C, OTHER) === LIMIT + 3, "downloads the large file from the release");
    const head11 = fake.head();
    r = await C.sync();
    check(noErrors(r) && fake.head() === head11 && !everCommitted(OTHER) && said(r, "Not syncing") === 0,
      "and doesn't try to put it in the repository");
    await C.edit("1.3.1のメモ.md", "まだ更新していない端末\n");
    r = await C.sync();
    check(noErrors(r) && fake.file("1.3.1のメモ.md") === "まだ更新していない端末\n" && inRelease(OTHER, LIMIT + 3),
      "its notes sync as usual");
    await A.remove(OTHER);
    r = await A.sync();
    r = await C.sync();
    check(noErrors(r) && sizeOn(C, OTHER) === null, "deleted on A, it goes from C too");
    r = await B.sync();
  } else {
    console.log("  (skipped: set PREVIOUS_BUILD to a transpiled 1.3.1)");
    await A.remove(OTHER);
    r = await A.sync();
    r = await B.sync();
  }
  check(noErrors(r) && sizeOn(B, OTHER) === null, "and from B");

  section("12. Everything agrees");
  check(autofix().length === 0, "the auto-fix has nothing to do");
  for (const [name, phone] of [["A", A], ["B", B]]) {
    r = await phone.sync();
    check(noErrors(r) && logged(r, "Nothing to sync"), `${name} has nothing left to sync`);
  }

  section("13. First sync from a vault with a file over 100 MB");
  const root13 = path.join(root, "first");
  const remote13 = path.join(root13, "remote.git");
  fs.mkdirSync(root13, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--bare", remote13]);
  const fake13 = new FakeGitHub(remote13);
  obsidian.setRequestHandler((req) => fake13.handle(req));
  const vaultDir = path.join(root13, "vault");
  fs.mkdirSync(path.join(vaultDir, "資料"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "ノート.md"), "最初のノート\n");
  fs.writeFileSync(path.join(vaultDir, BOOK), "");
  fs.truncateSync(path.join(vaultDir, BOOK), LIMIT + 1);
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
  check(error === null && fake13.file("ノート.md") === "最初のノート\n", `the first sync works (${error})`);
  check(fake13.bytes(BOOK) === null && !(BOOK in fake13.manifest().files), "without the PDF");
  await manager.sync();
  await vault.flush();
  const index13 = fake13.mediaIndex();
  check(!!index13 && index13.files[BOOK]?.size === LIMIT + 1, "which the next sync puts in the release");
  check(!obsidian.Notice.messages.slice(notices).some((n) => n.includes("Not syncing") || n.startsWith("Error")),
    "without a word of complaint");
  obsidian.setRequestHandler((req) => fake.handle(req));

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
