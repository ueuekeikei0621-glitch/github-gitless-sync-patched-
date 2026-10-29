// Videos and audio synced through a draft release (src/media-sync.ts), between
// several phones, with the auto-fix workflow and an older plugin version.
// Usage: node e2e/media-scenarios.js <vault repo> <sync_autofix.py>
//        OLD_BUILD=<1.1.0 built by transpile.js> adds the mixed-version section.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, git } = require("./lib");

const [SOURCE_REPO, SCRIPT] = process.argv.slice(2);
const INDEX = ".obsidian/github-sync-media.json";
const DAY = 24 * 60 * 60 * 1000;

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n== ${title}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-e2e-"));
const remote = path.join(root, "remote.git");
execFileSync("git", ["clone", "--quiet", "--bare", "--no-tags", SOURCE_REPO, remote]);
const head = execFileSync("git", ["-C", SOURCE_REPO, "rev-parse", process.env.BASE || "origin/main"]).toString().trim();
git(remote, ["update-ref", "refs/heads/main", head]);
git(remote, ["config", "uploadpack.allowFilter", "true"]);
const fake = new FakeGitHub(remote);
obsidian.setRequestHandler((req) => fake.handle(req));
const work = path.join(root, "work");
execFileSync("git", ["clone", "--quiet", "--filter=blob:none", `file://${remote}`, work]);

function autofix() {
  const out = execFileSync("python3", ["-I", SCRIPT, "--push"], { cwd: work }).toString();
  const lines = out.split("\n").filter(Boolean);
  for (const line of lines) console.log(`        autofix: ${line}`);
  return lines;
}

const noErrors = (r) => !r.notices.some((n) => n.startsWith("Error"));
// No error at all, media included
const quiet = (r) =>
  noErrors(r) && !r.notices.some((n) => /^(Videos and audio didn't|Couldn't|Not syncing|Not downloading)/.test(n));
const said = (r, text) => r.notices.some((n) => n.includes(text));
const logged = (r, message) => r.log.some((e) => e.message === message);
const bytes = (n) => crypto.randomBytes(n);
const same = (a, b) => !!a && !!b && Buffer.compare(a, b) === 0;
const index = () => fake.mediaIndex() || { files: {}, trash: [] };
// What the release holds for a path of the index
function stored(p) {
  const entry = index().files[p];
  const asset = entry && fake.assets()[entry.asset];
  return asset ? asset.data : null;
}
function readBytes(phone, p) {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}
async function put(phone, p, data) {
  phone.vault.writeFile(p, data);
  await phone.vault.flush();
}
// Like Obsidian: the file moves on disk, then a rename event.
async function move(phone, from, to) {
  const dst = path.join(phone.root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(path.join(phone.root, from), dst);
  for (const cb of phone.vault.handlers.rename || []) await cb(new obsidian.TFile(to), from);
  await phone.vault.flush();
}
const media = (phone) => phone.manager.mediaSync;

// A phone holding the notes of the repository as it is now
async function newPhone(name, build) {
  const metadata = fake.manifest();
  const files = {};
  for (const [p, entry] of Object.entries(metadata.files)) {
    if (entry.deleted || entry.sha === null || p.split("/").some((s) => s.startsWith("."))) continue;
    files[p] = git(remote, ["cat-file", "blob", entry.sha]);
  }
  const phone = new Phone(path.join(root, name), build);
  await phone.init(files, metadata);
  phone.vault.iosLike = true;
  return phone;
}

async function main() {
  const A = await newPhone("A");
  let r = await A.sync();
  check(quiet(r), "A syncs today's repository");

  section("1. A video pasted on A goes to the release, not the repository");
  const v1 = bytes(5000);
  await put(A, "動画/IMG_0001.mov", v1);
  await put(A, ".trash/old.mov", bytes(100));
  await A.edit("動画メモ.md", "今日の動画\n![[IMG_0001.mov]]\n");
  r = await A.sync();
  check(quiet(r), "no errors");
  check(fake.file("動画メモ.md") === "今日の動画\n![[IMG_0001.mov]]\n", "the note is in the repository");
  check(fake.bytes("動画/IMG_0001.mov") === null, "the video is not");
  check(!("動画/IMG_0001.mov" in fake.manifest().files), "nor in the notes metadata");
  check(same(stored("動画/IMG_0001.mov"), v1), "the release holds it byte for byte");
  check(fake.releases.length === 1 && fake.releases[0].draft && fake.releases[0].tag_name === "obsidian-media",
    "one draft release, which makes no tag");
  check(/^[0-9a-f]{40}\.mov$/.test(index().files["動画/IMG_0001.mov"].name), "the asset is named by its content");
  check(Object.keys(index().files).length === 1, "hidden folders are left out");
  check(fake.subjects(1)[0] === "Sync", "the index is committed as a plugin Sync commit");
  check(autofix().length === 0, "the auto-fix has nothing to do");

  section("2. B gets it");
  const B = await newPhone("B");
  r = await B.sync();
  check(quiet(r) && same(readBytes(B, "動画/IMG_0001.mov"), v1), "B downloads the video byte for byte");

  section("3. A sync with nothing new");
  let mark = fake.requests.length;
  r = await B.sync();
  const asked = fake.requests.slice(mark).filter((q) => /contents|releases/.test(q));
  check(quiet(r) && asked.length === 0, `asks GitHub nothing about media (${asked.join(", ")})`);

  section("4. A moves the video: B follows, nothing is uploaded again");
  let uploads = fake.uploads;
  await move(A, "動画/IMG_0001.mov", "動画/2026/IMG_0001.mov");
  r = await A.sync();
  check(quiet(r), "no errors");
  check(!("動画/IMG_0001.mov" in index().files) && same(stored("動画/2026/IMG_0001.mov"), v1), "the index follows the move");
  check(index().trash.some((e) => e.path === "動画/IMG_0001.mov"), "the old path is recorded as deleted");
  check(fake.uploads === uploads, "the release isn't uploaded to");
  r = await B.sync();
  check(quiet(r) && readBytes(B, "動画/IMG_0001.mov") === null && same(readBytes(B, "動画/2026/IMG_0001.mov"), v1),
    "B moves it too");

  section("5. B deletes it: A deletes its copy, the release keeps it for a while");
  await B.remove("動画/2026/IMG_0001.mov");
  r = await B.sync();
  check(quiet(r) && !("動画/2026/IMG_0001.mov" in index().files), "B's deletion reaches the index");
  const deleted = index().trash.find((e) => e.path === "動画/2026/IMG_0001.mov");
  check(deleted !== undefined, "recorded as deleted");
  r = await A.sync();
  check(quiet(r) && readBytes(A, "動画/2026/IMG_0001.mov") === null, "A deletes its copy");
  check(fake.assets()[deleted.asset] !== undefined, "the release still has the file");

  section("6. 31 days later the trash is emptied");
  const later = Date.now() + 31 * DAY;
  media(A).now = () => later;
  fake.clock = () => later;
  r = await A.sync();
  check(quiet(r) && index().trash.length === 0, "the deleted entries leave the index");
  check(fake.assets()[deleted.asset] === undefined, "and the file leaves the release");
  media(A).now = () => Date.now();
  fake.clock = () => Date.now();

  section("7. The index is lost: nothing is deleted, the index comes back");
  const v2 = bytes(4000), v3 = bytes(3000);
  await put(A, "動画/a.mp4", v2);
  r = await A.sync();
  await put(B, "音声/b.m4a", v3);
  r = await B.sync();
  r = await A.sync();
  check(same(readBytes(A, "音声/b.m4a"), v3) && same(readBytes(B, "動画/a.mp4"), v2), "both phones have both files");
  uploads = fake.uploads;
  fake.externalCommit({ remove: [INDEX], message: "Delete the media index" });
  const rA = await A.sync();
  const rB = await B.sync();
  r = await A.sync();
  check(quiet(rA) && quiet(rB) && quiet(r), "no errors");
  check(same(readBytes(A, "動画/a.mp4"), v2) && same(readBytes(A, "音声/b.m4a"), v3) &&
    same(readBytes(B, "動画/a.mp4"), v2) && same(readBytes(B, "音声/b.m4a"), v3), "no phone deleted anything");
  check(same(stored("動画/a.mp4"), v2) && same(stored("音声/b.m4a"), v3), "the index is rebuilt");
  check(fake.uploads === uploads, "from the files already in the release");

  section("8. A failed upload doesn't hold up the notes, and is retried");
  const v4 = bytes(2500);
  await put(A, "動画/c.mov", v4);
  await A.edit("メモ8.md", "動画のあとで書いたメモ\n");
  fake.faults.push({ key: "POST releases/", status: 500 });
  r = await A.sync();
  check(noErrors(r) && fake.file("メモ8.md") === "動画のあとで書いたメモ\n", "the note is synced");
  check(!("動画/c.mov" in index().files) && said(r, "Couldn't sync 動画/c.mov"), "the video isn't yet, and A says so");
  r = await A.sync();
  check(quiet(r) && same(stored("動画/c.mov"), v4), "the next sync uploads it");

  section("9. A commit lands while A commits the index");
  const v5 = bytes(2200);
  await put(A, "動画/d.mov", v5);
  uploads = fake.uploads;
  // A has no notes to commit, so the next branch update is the index commit
  fake.once("PATCH git/refs/heads/main", async () => {
    fake.externalCommit({ write: { "メモ9.md": "Claudeのメモ\n" }, message: "Add メモ9.md" });
  });
  r = await A.sync();
  check(quiet(r) && logged(r, "Media sync: branch moved, starting over"), "A notices the branch moved");
  check(same(stored("動画/d.mov"), v5) && fake.file("メモ9.md") === "Claudeのメモ\n", "commits the index on top of Claude's commit");
  check(fake.uploads === uploads + 1, "and uploads the video once");

  section("10. Both phones change the same video: both versions are kept");
  r = await B.sync();
  check(same(readBytes(B, "動画/d.mov"), v5), "B has d.mov");
  const vA = bytes(2600), vB = bytes(2700);
  await put(A, "動画/d.mov", vA);
  r = await A.sync();
  await put(B, "動画/d.mov", vB);
  r = await B.sync();
  check(quiet(r), "no errors");
  const copies = Object.keys(index().files).filter((p) => p.startsWith("動画/d（GitHub側の版 "));
  check(same(readBytes(B, "動画/d.mov"), vB) && same(stored("動画/d.mov"), vB), "B's version wins at the path");
  check(copies.length === 1 && same(stored(copies[0]), vA) && same(readBytes(B, copies[0]), vA),
    `A's version is kept next to it (${copies.join(", ")})`);
  r = await A.sync();
  check(quiet(r) && same(readBytes(A, "動画/d.mov"), vB) && same(readBytes(A, copies[0]), vA), "A ends up with both");

  section("11. Deleted on B while edited on A: the edit wins");
  await B.sync();
  await B.remove("動画/c.mov");
  r = await B.sync();
  check(quiet(r) && !("動画/c.mov" in index().files), "B's deletion reaches the index");
  const vC = bytes(2900);
  await put(A, "動画/c.mov", vC);
  r = await A.sync();
  check(quiet(r) && same(stored("動画/c.mov"), vC) && same(readBytes(A, "動画/c.mov"), vC), "A's edit goes back in");
  r = await B.sync();
  check(quiet(r) && same(readBytes(B, "動画/c.mov"), vC), "and B gets it back");

  section("12. Size limit");
  const C = await newPhone("C");
  C.settings.releaseMaxSizeMB = 0.004; // 4194 bytes
  const big = bytes(5000);
  await put(A, "動画/big.mov", big);
  r = await A.sync();
  r = await C.sync();
  check(readBytes(C, "動画/big.mov") === null && said(r, "Not downloading 動画/big.mov"),
    "C, limited to 4 KB, doesn't download a 5 KB video, and says so");
  check(same(readBytes(C, "動画/c.mov"), vC), "smaller ones arrive");
  await put(C, "動画/c-big.mov", bytes(6000));
  r = await C.sync();
  check(!("動画/c-big.mov" in index().files) && said(r, "Not syncing 動画/c-big.mov"), "nor uploads one");
  r = await C.sync();
  check(!said(r, "Not syncing"), "and says it once");

  section("13. Downloads turned off on D");
  const D = await newPhone("D");
  D.settings.downloadReleaseMedia = false;
  r = await D.sync();
  check(quiet(r) && readBytes(D, "動画/c.mov") === null, "D downloads nothing");
  const vD = bytes(1500);
  await put(D, "音声/d.m4a", vD);
  r = await D.sync();
  check(quiet(r) && same(stored("音声/d.m4a"), vD), "but uploads its own");
  r = await A.sync();
  check(quiet(r) && same(readBytes(A, "音声/d.m4a"), vD), "which reach A");

  section("14. A transfer that kills the app is given up after two tries");
  const vK = bytes(3300);
  await put(A, "動画/k.mov", vK);
  media(A).state.pending = { path: "動画/k.mov", size: vK.length, attempts: 2 };
  r = await A.sync();
  check(!("動画/k.mov" in index().files) && said(r, "it seems too large for this device"), "A leaves the file alone, and says so");
  r = await A.sync();
  check(!("動画/k.mov" in index().files) && !said(r, "too large"), "quietly from then on");
  A.settings.releaseMaxSizeMB = 200;
  r = await A.sync();
  check(quiet(r) && same(stored("動画/k.mov"), vK), "a new size limit brings another try");
  A.settings.releaseMaxSizeMB = 100;

  section("15. A video already in the repository stays there");
  fake.externalCommit({ write: { "動画/legacy.mp4": bytes(1200) }, message: "Add a video to the repository" });
  r = await A.sync();
  check(quiet(r) && readBytes(A, "動画/legacy.mp4") !== null && !("動画/legacy.mp4" in index().files),
    "A gets it through the repository");
  const vL = bytes(1300);
  await put(A, "動画/legacy.mp4", vL);
  r = await A.sync();
  check(quiet(r) && same(fake.bytes("動画/legacy.mp4"), vL) && !("動画/legacy.mp4" in index().files),
    "and edits go back to the repository");

  section("16. A device with the older plugin keeps the index");
  if (process.env.OLD_BUILD) {
    const O = await newPhone("O", process.env.OLD_BUILD);
    const before = fake.file(INDEX);
    await O.edit("古い端末.md", "1.1.0 で書いたメモ\n");
    await put(O, "動画/old-device.mov", bytes(900));
    r = await O.sync();
    check(noErrors(r) && fake.file("古い端末.md") === "1.1.0 で書いたメモ\n", "1.1.0 syncs its notes as before");
    check(fake.bytes("動画/old-device.mov") === null, "keeps its video on the device, as before");
    check(fake.file(INDEX) === before, "and leaves the index alone");
    r = await A.sync();
    check(quiet(r) && A.read("古い端末.md") === "1.1.0 で書いたメモ\n", "A carries on");
  } else {
    console.log("  (skipped: set OLD_BUILD to a transpiled 1.1.0)");
  }

  section("17. A new device: first sync, then the videos");
  const E = new Phone(path.join(root, "E"));
  await E.init({}, { lastSync: 0, files: {} });
  E.settings.firstSync = true;
  await E.manager.firstSync();
  E.settings.firstSync = false;
  r = await E.sync();
  check(quiet(r), "no errors");
  check(Object.keys(index().files).every((p) => same(readBytes(E, p), stored(p))), "E has every video and recording");
  check(!fs.existsSync(path.join(E.root, INDEX)), "and doesn't keep a copy of the index");

  section("18. Everything agrees");
  for (const phone of [A, B, E]) await phone.sync();
  const listed = Object.keys(index().files);
  for (const [name, phone] of [["A", A], ["B", B], ["E", E]]) {
    const missing = listed.filter((p) => !same(readBytes(phone, p), stored(p)));
    check(missing.length === 0, `${name} matches the index (${missing.join(", ")})`);
  }
  check(listed.every((p) => fake.bytes(p) === null), "none of them is in the repository");
  check(listed.every((p) => !(p in fake.manifest().files)), "nor in the notes metadata");
  check(autofix().length === 0, "the auto-fix has nothing to do");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
