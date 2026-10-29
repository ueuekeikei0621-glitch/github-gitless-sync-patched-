// New photos shrunk before upload (src/image-shrink.ts), with a stand-in
// encoder; e2e/image-encode-test.js runs the real one in Chromium.
// Usage: node e2e/image-scenarios.js <vault repo> <sync_autofix.py>
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, git } = require("./lib");

const [SOURCE_REPO, SCRIPT] = process.argv.slice(2);
const MINUTE = 60 * 1000;

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n== ${title}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-e2e-"));
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
const said = (r, text) => r.notices.some((n) => n.includes(text));
const same = (a, b) => !!a && !!b && Buffer.compare(a, b) === 0;
function readBytes(phone, p) {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}
async function put(phone, p, data) {
  phone.vault.writeFile(p, data);
  await phone.vault.flush();
}
// Whether p was ever committed, in any version
const everCommitted = (p) => git(remote, ["log", "--all", "--format=%H", "--", p]).toString().trim() !== "";
const commitsOf = (p) => git(remote, ["log", "--all", "--format=%H", "--", p]).toString().trim().split("\n").filter(Boolean).length;

// Stand-in images: a header with the size in pixels, then filler bytes
function image(width, height, size) {
  const header = Buffer.from(`FAKEIMG ${width}x${height}\n`);
  return Buffer.concat([header, crypto.randomBytes(size - header.length)]);
}
const encoded = []; // calls to the stand-in encoder
// Like encodeImage: scales the longest side down to maxSide, about 0.08
// bytes per pixel at quality 100; null for anything it can't decode.
async function encode(data, type, maxSide, quality) {
  encoded.push(type);
  const m = Buffer.from(data).subarray(0, 40).toString("latin1").match(/^FAKEIMG (\d+)x(\d+)\n/);
  if (!m) return null;
  const scale = Math.min(1, maxSide / Math.max(+m[1], +m[2]));
  const width = Math.round(+m[1] * scale), height = Math.round(+m[2] * scale);
  const header = Buffer.from(`FAKEJPG ${width}x${height} q${quality}\n`);
  const out = Buffer.concat([header, Buffer.alloc(Math.max(0, Math.round(width * height * 0.0008 * quality) - header.length), 7)]);
  return { data: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), width, height };
}
const header = (bytes) => bytes ? bytes.subarray(0, 40).toString("latin1").split("\n")[0] : null;

// As on the user's devices: only video and audio are kept off the repository
const DEVICE = { mediaExtensions: "mp4, mov, m4v, webm, mkv, ogv, avi, 3gp, mp3, m4a, wav, aac, ogg, oga, opus, flac" };

async function newPhone(name, settings = {}) {
  const metadata = fake.manifest();
  const files = {};
  for (const [p, entry] of Object.entries(metadata.files)) {
    if (entry.deleted || entry.sha === null || p.split("/").some((s) => s.startsWith("."))) continue;
    files[p] = git(remote, ["cat-file", "blob", entry.sha]);
  }
  const phone = new Phone(path.join(root, name));
  await phone.init(files, metadata);
  Object.assign(phone.settings, DEVICE, settings);
  phone.vault.iosLike = true;
  phone.manager.images.encode = encode;
  return phone;
}
// The phone's clock, minutes from now
const at = (phone, minutes) => { phone.manager.images.now = () => Date.now() + minutes * MINUTE; };
// Sets a file's modification time, minutes from now
const touch = (phone, p, minutes) => {
  const when = new Date(Date.now() + minutes * MINUTE);
  fs.utimesSync(path.join(phone.root, p), when, when);
};

async function main() {
  let rewriteLinks = null;
  let rewriteCanvas = null;
  try {
    ({ rewriteLinks, rewriteCanvas } = require("./plugin")("image-shrink"));
  } catch {
    // A bundle doesn't export them; the sections below rewrite links through them
  }

  section("0. Links follow a renamed image, nothing else changes");
  if (rewriteLinks === null) console.log("  (skipped: rewriteLinks isn't exported by this build)");
  // As written in notes/メモ.md, about img/Pasted image 1.png
  const cases = rewriteLinks === null ? [] : [
    ["![[Pasted image 1.png]]", "![[Pasted image 1.jpg]]"],
    ["![[Pasted image 1.png|300]]", "![[Pasted image 1.jpg|300]]"],
    ["| ![[Pasted image 1.png\\|300]] | 説明 |", "| ![[Pasted image 1.jpg\\|300]] | 説明 |"],
    ["[[img/Pasted image 1.png#x|写真]]", "[[img/Pasted image 1.jpg#x|写真]]"],
    ["![[pasted image 1.PNG]]", "![[pasted image 1.jpg]]"],
    ["![[../img/Pasted image 1.png]]", "![[../img/Pasted image 1.jpg]]"],
    ["![](Pasted%20image%201.png)", "![](Pasted%20image%201.jpg)"],
    ["![](/img/Pasted%20image%201.png#center)", "![](/img/Pasted%20image%201.jpg#center)"],
    ["![](/IMG/pasted%20image%201.PNG)", "![](/IMG/pasted%20image%201.jpg)"],
    ["![写真](<img/Pasted image 1.png> \"説明\")", "![写真](<img/Pasted image 1.jpg> \"説明\")"],
    ["Pasted image 1.png と本文に書いただけ", "Pasted image 1.png と本文に書いただけ"],
    ["![[Pasted image 11.png]]", "![[Pasted image 11.png]]"],
    ["![[other/Pasted image 1.png]]", "![[other/Pasted image 1.png]]"],
    ["![](./Pasted%20image%201.png)", "![](./Pasted%20image%201.png)"],
    ["![](../../img/Pasted%20image%201.png)", "![](../../img/Pasted%20image%201.png)"],
    ["`![[Pasted image 1.png]]` a ![[Pasted image 1.png]] b", "`![[Pasted image 1.jpg]]` a ![[Pasted image 1.jpg]] b"],
  ];
  for (const [before, after] of cases) {
    const got = rewriteLinks(before, "img/Pasted image 1.png", "img/Pasted image 1.jpg", "notes/メモ.md");
    check(got === after, `${before}  →  ${got}`);
  }
  if (rewriteLinks !== null) {
    check(rewriteLinks("![[dup.png]] ![](dup.png) ![](<dup.png>)", "dup.png", "dup 1.jpg", "メモ.md") ===
      "![[dup 1.jpg]] ![](dup%201.jpg) ![](<dup 1.jpg>)", "a numbered name replaces the whole name, a space encoded where it must be");
    check(rewriteLinks("![](a%20b.png)", "a b.png", "a b 1.jpg", "メモ.md") === "![](a%20b%201.jpg)", "encoded links stay encoded");
    const board = JSON.stringify({ nodes: [
      { id: "1", type: "file", file: "img/Pasted image 1.png", x: 0, y: 0, width: 400, height: 300 },
      { id: "2", type: "text", text: "説明 ![[img/Pasted image 1.png|200]]", x: 0, y: 320, width: 400, height: 80 },
      { id: "3", type: "file", file: "other/Pasted image 1.png", x: 420, y: 0, width: 400, height: 300 },
    ], edges: [] }, null, "\t");
    const after = JSON.parse(board);
    after.nodes[0].file = "img/Pasted image 1.jpg";
    after.nodes[1].text = "説明 ![[img/Pasted image 1.jpg|200]]";
    check(rewriteCanvas(board, "img/Pasted image 1.png", "img/Pasted image 1.jpg", "ボード.canvas") === JSON.stringify(after, null, "\t"),
      "a canvas: its card showing the image and the links in its text cards, indented as before");
    check(rewriteCanvas("{ not json", "a.png", "a.jpg", "x.canvas") === "{ not json", "a canvas that isn't JSON stays as it is");
  }

  const A = await newPhone("A");
  let r = await A.sync();
  check(noErrors(r), "A syncs today's repository");

  section("1. A photo pasted as PNG");
  const png = image(4032, 3024, 6_000_000);
  await put(A, "Pasted image 1.png", png);
  await A.edit("写真メモ.md", "今日の写真\n![[Pasted image 1.png]]\n");
  r = await A.sync();
  check(noErrors(r) && fake.file("写真メモ.md") === "今日の写真\n![[Pasted image 1.png]]\n", "the note goes up at once");
  check(!everCommitted("Pasted image 1.png") && !said(r, "Photos shrunk"), "the photo waits, it was just pasted");
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && said(r, "Photos shrunk: 1 (5.7 MB → "), `a minute later it's shrunk, and A says so (${r.notices.join(" / ")})`);
  check(readBytes(A, "Pasted image 1.png") === null && header(readBytes(A, "Pasted image 1.jpg")) === "FAKEJPG 2500x1875 q80",
    "to 2500 pixels as JPEG, under a .jpg name");
  check(A.read("写真メモ.md") === "今日の写真\n![[Pasted image 1.jpg]]\n", "the note's link follows");
  check(same(fake.bytes("Pasted image 1.jpg"), readBytes(A, "Pasted image 1.jpg")) &&
    fake.file("写真メモ.md") === "今日の写真\n![[Pasted image 1.jpg]]\n", "GitHub gets the small photo and the new link");
  check(!everCommitted("Pasted image 1.png"), "the original never reached GitHub");
  check(autofix().length === 0, "the auto-fix has nothing to do");

  section("2. Another device gets the small photo and leaves it alone");
  const before = encoded.length;
  const B = await newPhone("B");
  r = await B.sync();
  check(noErrors(r) && same(readBytes(B, "Pasted image 1.jpg"), readBytes(A, "Pasted image 1.jpg")) &&
    B.read("写真メモ.md") === "今日の写真\n![[Pasted image 1.jpg]]\n", "B has the photo and the note");
  check(encoded.length === before, "and shrinks nothing it downloaded");

  section("3. A photo no note links to waits longer");
  await put(A, "写真/単独.png", image(3000, 2000, 3_000_000));
  at(A, 1.5);
  r = await A.sync();
  check(!everCommitted("写真/単独.png") && !everCommitted("写真/単独.jpg"), "a minute and a half later, it still waits");
  at(A, 4);
  r = await A.sync();
  check(noErrors(r) && header(fake.bytes("写真/単独.jpg")) === "FAKEJPG 2500x1667 q80" && !everCommitted("写真/単独.png"),
    "three minutes later it's shrunk and uploaded");
  await put(A, "写真/古い日付.png", image(3000, 2000, 3_000_000));
  touch(A, "写真/古い日付.png", -60 * 24 * 30); // copied in with the date it was taken
  at(A, 1.5);
  r = await A.sync();
  check(!everCommitted("写真/古い日付.png") && !everCommitted("写真/古い日付.jpg"), "a photo copied in with an old date waits too");
  at(A, 4);
  r = await A.sync();
  check(noErrors(r) && header(fake.bytes("写真/古い日付.jpg")) === "FAKEJPG 2500x1667 q80", "and is shrunk in turn");

  section("4. A JPEG photo shrinks in place");
  at(A, 0);
  await put(A, "IMG_0002.jpg", image(4032, 3024, 5_000_000));
  await A.edit("メモ4.md", "![[IMG_0002.jpg]]\n");
  r = await A.sync();
  check(!everCommitted("IMG_0002.jpg"), "it waits a few seconds after it's written");
  at(A, 0.2);
  r = await A.sync();
  check(noErrors(r) && header(fake.bytes("IMG_0002.jpg")) === "FAKEJPG 2500x1875 q80", "then it's shrunk under the same name");
  check(commitsOf("IMG_0002.jpg") === 1 && A.read("メモ4.md") === "![[IMG_0002.jpg]]\n", "uploaded once, the note as it was");

  section("5. Screenshots, GIF and SVG stay as they are");
  const shot = image(1206, 2622, 800_000);
  const gif = image(2000, 2000, 2_000_000);
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>\n");
  await put(A, "IMG_5500.png", shot);
  await put(A, "anim.gif", gif);
  await put(A, "図.svg", svg);
  at(A, 0);
  r = await A.sync();
  check(same(fake.bytes("IMG_5500.png"), shot), "a screenshot under 1 MB goes up at once, untouched");
  check(same(fake.bytes("anim.gif"), gif) && same(fake.bytes("図.svg"), svg), "GIF and SVG too");

  section("6. A HEIC photo becomes JPEG");
  await put(A, "IMG_0003.HEIC", image(4032, 3024, 2_000_000));
  await A.edit("メモ6.md", "![[IMG_0003.HEIC]]\n");
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && header(fake.bytes("IMG_0003.jpg")) === "FAKEJPG 2500x1875 q80" && !everCommitted("IMG_0003.HEIC"),
    "converted, so PCs and Claude can open it");
  check(fake.file("メモ6.md") === "![[IMG_0003.jpg]]\n", "with its link");

  section("7. What can't be shrunk goes up as it is");
  const odd = crypto.randomBytes(2_000_000);
  await put(A, "壊れた画像.png", odd);
  await A.edit("メモ7.md", "![[壊れた画像.png]]\n");
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes("壊れた画像.png"), odd) && A.read("メモ7.md") === "![[壊れた画像.png]]\n",
    "an image this device can't decode, untouched");
  const lean = image(2400, 1800, 350_000);
  await put(A, "lean.jpg", lean);
  at(A, 2);
  r = await A.sync();
  check(same(fake.bytes("lean.jpg"), lean), "a JPEG that would shrink by less than a quarter, untouched");
  const fail = image(4000, 3000, 3_000_000);
  await put(A, "fail.png", fail);
  A.manager.images.encode = async () => { throw new Error("out of memory"); };
  at(A, 4);
  r = await A.sync();
  A.manager.images.encode = encode;
  check(noErrors(r) && same(fake.bytes("fail.png"), fail), "an encoder that throws doesn't stop the sync");

  section("8. The .jpg name is taken");
  const small = image(800, 600, 200_000);
  await put(A, "dup.jpg", small);
  at(A, 0.2);
  r = await A.sync();
  await put(A, "dup.png", image(4000, 3000, 4_000_000));
  await A.edit("メモ8.md", "![[dup.png]] と ![[dup.jpg]] と ![](dup.png)\n");
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && same(fake.bytes("dup.jpg"), small) && header(fake.bytes("dup 1.jpg")) === "FAKEJPG 2500x1875 q80",
    "the photo becomes dup 1.jpg, dup.jpg stays");
  check(fake.file("メモ8.md") === "![[dup 1.jpg]] と ![[dup.jpg]] と ![](dup%201.jpg)\n", "and only its links change");

  section("9. Links in every form, and a same-named file elsewhere");
  const other = image(640, 480, 100_000);
  await put(A, "other/Pasted image 2.png", other);
  await put(A, "img/Pasted image 2.png", image(4000, 3000, 4_000_000));
  const note9 = [
    "![[Pasted image 2.png]]",
    "![[img/Pasted image 2.png|200]]",
    "![](img/Pasted%20image%202.png)",
    "![図](<img/Pasted image 2.png>)",
    "![[other/Pasted image 2.png]]",
    "本文の Pasted image 2.png はそのまま",
    "",
  ].join("\n");
  await A.edit("メモ9.md", note9);
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && fake.file("メモ9.md") === [
    "![[Pasted image 2.jpg]]",
    "![[img/Pasted image 2.jpg|200]]",
    "![](img/Pasted%20image%202.jpg)",
    "![図](<img/Pasted image 2.jpg>)",
    "![[other/Pasted image 2.png]]",
    "本文の Pasted image 2.png はそのまま",
    "",
  ].join("\n"), "each link to it follows; the other file and plain text don't");
  check(same(fake.bytes("other/Pasted image 2.png"), other), "the same-named small file stays");

  section("10. Images from GitHub are never shrunk");
  const drawn = image(4000, 3000, 3_000_000);
  fake.externalCommit({ write: { "Claude画像/図.png": drawn }, message: "Add Claude画像/図.png" });
  const calls = encoded.length;
  at(A, 10);
  r = await A.sync();
  r = await A.sync();
  check(noErrors(r) && same(readBytes(A, "Claude画像/図.png"), drawn) && same(fake.bytes("Claude画像/図.png"), drawn),
    "a large PNG Claude added stays as it is");
  check(encoded.length === calls, "nothing was even decoded");

  section("11. Settings");
  const C = await newPhone("C", { mediaExtensions: "png, jpg, mov" });
  const kept = image(4000, 3000, 4_000_000);
  await put(C, "local.png", kept);
  at(C, 5);
  r = await C.sync();
  check(same(readBytes(C, "local.png"), kept) && !everCommitted("local.png"), "photos kept on the device stay untouched");
  const D = await newPhone("D", { shrinkImages: false });
  const plain = image(4000, 3000, 4_000_000);
  await put(D, "plain.png", plain);
  r = await D.sync();
  check(same(fake.bytes("plain.png"), plain), "with shrinking off, photos go up at once, as they are");
  const E = await newPhone("E", { imageMaxSide: 1600, imageQuality: 60 });
  await put(E, "custom.png", image(4000, 3000, 4_000_000));
  await E.edit("メモ11.md", "![[custom.png]]\n");
  at(E, 2);
  r = await E.sync();
  check(header(fake.bytes("custom.jpg")) === "FAKEJPG 1600x1200 q60", "size and quality follow the settings");

  section("12. A photo waits while its note is being written");
  at(A, 0);
  await put(A, "Pasted image 12.png", image(4032, 3024, 5_000_000));
  await A.edit("メモ12.md", "![[Pasted image 12.png]]\n");
  touch(A, "メモ12.md", 1.9); // still typing two minutes later
  at(A, 2);
  r = await A.sync();
  check(noErrors(r) && !everCommitted("Pasted image 12.png") && !everCommitted("Pasted image 12.jpg") &&
    A.read("メモ12.md") === "![[Pasted image 12.png]]\n", "the photo waits while the note keeps changing");
  at(A, 3);
  r = await A.sync();
  check(noErrors(r) && header(fake.bytes("Pasted image 12.jpg")) === "FAKEJPG 2500x1875 q80" &&
    fake.file("メモ12.md") === "![[Pasted image 12.jpg]]\n", "a minute after the last change, it's shrunk and the link follows");

  section("13. A canvas showing a photo follows it");
  const board = { nodes: [
    { id: "b1", type: "file", file: "Pasted image 13.png", x: 0, y: 0, width: 400, height: 300 },
    { id: "b2", type: "text", text: "説明 ![[Pasted image 13.png|200]]", x: 0, y: 320, width: 400, height: 80 },
  ], edges: [] };
  at(A, 0);
  await put(A, "Pasted image 13.png", image(4032, 3024, 5_000_000));
  await A.edit("ボード.canvas", JSON.stringify(board, null, "\t"));
  at(A, 2);
  r = await A.sync();
  board.nodes[0].file = "Pasted image 13.jpg";
  board.nodes[1].text = "説明 ![[Pasted image 13.jpg|200]]";
  check(noErrors(r) && header(fake.bytes("Pasted image 13.jpg")) === "FAKEJPG 2500x1875 q80" &&
    fake.file("ボード.canvas") === JSON.stringify(board, null, "\t"), "its card and the link in its text card follow");

  section("14. A photo the app died on twice is left as it is");
  const STATE = ".obsidian/github-sync-image-state.json";
  const keyOf = (phone, p) => {
    const st = fs.statSync(path.join(phone.root, p));
    return `${p}\n${st.size}\n${Math.floor(st.mtimeMs)}`;
  };
  // As after a restart that follows a crash
  const crashed = (phone, attempts) => {
    fs.writeFileSync(path.join(phone.root, STATE), JSON.stringify({ attempts }));
    phone.manager.images.state = null;
  };
  await put(A, "once.png", image(4000, 3000, 4_000_000));
  const onceKey = keyOf(A, "once.png");
  crashed(A, { [onceKey]: 1 });
  let recorded = null;
  A.manager.images.encode = async (...args) => {
    recorded = JSON.parse(fs.readFileSync(path.join(A.root, STATE), "utf8")).attempts;
    return encode(...args);
  };
  at(A, 4);
  r = await A.sync();
  A.manager.images.encode = encode;
  check(recorded !== null && recorded[onceKey] === 2 && Object.keys(recorded).length === 1,
    "each try is saved before decoding, counting the one the app died on");
  check(noErrors(r) && header(fake.bytes("once.jpg")) === "FAKEJPG 2500x1875 q80", "after one crash it's tried again, and shrunk");
  check(Object.keys(JSON.parse(fs.readFileSync(path.join(A.root, STATE), "utf8")).attempts).length === 0, "then the try is forgotten");
  const huge = image(9000, 7000, 6_000_000);
  await put(A, "huge.png", huge);
  await A.edit("メモ14.md", "![[huge.png]]\n");
  crashed(A, { [keyOf(A, "huge.png")]: 2 });
  const calls14 = encoded.length;
  at(A, 2);
  r = await A.sync();
  check(said(r, "Not shrinking huge.png: it seems too large for this device.") && encoded.length === calls14,
    "after two, it isn't decoded again, and A says so");
  check(noErrors(r) && same(fake.bytes("huge.png"), huge) && fake.file("メモ14.md") === "![[huge.png]]\n", "it goes up as it is");
  at(A, 3);
  r = await A.sync();
  check(Object.keys(JSON.parse(fs.readFileSync(path.join(A.root, STATE), "utf8")).attempts).length === 0,
    "and it's forgotten once uploaded");
  check(!everCommitted(STATE) && !(STATE in fake.manifest().files), "the device's record never goes to GitHub");

  section("15. Everything agrees");
  for (const phone of [A, B]) {
    at(phone, 10);
    await phone.sync();
  }
  const tracked = git(remote, ["ls-tree", "-r", "--name-only", "-z", "main"]).toString("utf8").split("\0")
    .filter((p) => p && !p.split("/").some((s) => s.startsWith(".")));
  const differ = tracked.filter((p) => !same(readBytes(B, p), fake.bytes(p)));
  check(differ.length === 0, `B matches GitHub (${differ.join(", ")})`);
  check(autofix().length === 0, "the auto-fix has nothing to do");

  section("16. With the config folder synced, the device's record stays on it");
  const F = await newPhone("F", { syncConfigDir: true });
  fs.writeFileSync(path.join(F.root, STATE), JSON.stringify({ attempts: {} }));
  await F.manager.addConfigDirToMetadata();
  r = await F.sync();
  check(noErrors(r) && !everCommitted(STATE) && !(STATE in fake.manifest().files), "it isn't uploaded");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
