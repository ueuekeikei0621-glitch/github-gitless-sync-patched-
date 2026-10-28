// Scenarios for the patched plugin, on an iOS-like vault, with and without
// the auto-fix Action. Usage: node e2e/plugin-scenarios.js <vault repo> <sync_autofix.py>
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, git } = require("./lib");

const [SOURCE_REPO, SCRIPT] = process.argv.slice(2);

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n== ${title}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "patched-e2e-"));
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
const logged = (r, message) => r.log.some((e) => e.message === message);

// Like Obsidian: the file moves on disk, then a rename event.
async function move(phone, from, to) {
  const dst = path.join(phone.root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(path.join(phone.root, from), dst);
  for (const cb of phone.vault.handlers.rename || []) await cb(new obsidian.TFile(to), from);
  await phone.vault.flush();
}

function readBytes(phone, p) {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}

// A 1x1 PNG, and bytes that are not valid UTF-8 like any real docx.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
const PNG2 = Buffer.concat([PNG, Buffer.from([0x00, 0xff])]);
const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28]);

async function main() {
  // The phone as it is now: what the latest metadata lists, at those versions.
  const metadata = fake.manifest();
  const files = {};
  for (const [p, entry] of Object.entries(metadata.files)) {
    if (entry.deleted || p.split("/").some((s) => s.startsWith("."))) continue;
    files[p] = git(remote, ["cat-file", "blob", entry.sha]).toString("utf8");
  }
  const phone = new Phone(path.join(root, "phone"));
  await phone.init(files, metadata);
  phone.vault.iosLike = true;

  section("0. Patched plugin on today's repository");
  let r = await phone.sync();
  check(noErrors(r), "syncs without errors");

  section("1. Claude adds a note, no auto-fix run");
  const hypoK = "医学メモ/低カリウム血症.md";
  fake.externalCommit({ write: { [hypoK]: "# 低カリウム血症\n\n- 筋力低下\n" } });
  r = await phone.sync();
  check(noErrors(r) && phone.read(hypoK) === "# 低カリウム血症\n\n- 筋力低下\n", "the plugin itself picks it up");

  section("2. Claude edits a note the phone did not touch, no auto-fix run");
  const hyperK = "医学メモ/高カリウム血症.md";
  const kEdited = fake.file(hyperK) + "\n- Claudeが追記\n";
  fake.externalCommit({ write: { [hyperK]: kEdited } });
  r = await phone.sync();
  check(noErrors(r) && phone.read(hyperK) === kEdited, "the edit arrives");

  section("3. Claude and the phone edit the same note, no auto-fix run");
  const lowNa = "低ナトリウム血症の鑑別と初期対応.md";
  const naBase = fake.file(lowNa);
  fake.externalCommit({ write: { [lowNa]: naBase + "\nClaude追記\n" } });
  await phone.edit(lowNa, naBase + "\niPhone追記\n");
  const merged = naBase + "\niPhone追記\nClaude追記\n";
  phone.resolve = (cs) => cs.map((c) => ({ filePath: c.filePath, content: merged }));
  let seen = phone.conflicts.length;
  r = await phone.sync();
  const c3 = phone.conflicts[seen];
  check(noErrors(r) && c3 && c3.filePath === lowNa, "the conflict view opens");
  check(c3 && c3.remoteContent.endsWith("Claude追記\n") && c3.localContent.endsWith("iPhone追記\n"), "with both versions");
  check(fake.file(lowNa) === merged && phone.read(lowNa) === merged, "the merged text is on both sides");
  r = await phone.sync();
  check(logged(r, "Nothing to sync"), "the next sync has nothing to do (no repeat upload)");
  check(autofix().length === 0, "the auto-fix finds nothing to fix");

  section("4. Claude deletes a note the phone did not touch, no auto-fix run");
  fake.externalCommit({ remove: [hypoK], message: `Delete ${hypoK}` });
  r = await phone.sync();
  check(noErrors(r) && phone.read(hypoK) === null, "the note is deleted on the phone");

  section("5. Claude deletes a note the phone has edited");
  await phone.edit("メモA.md", "最初\n");
  await phone.sync();
  await phone.edit("メモA.md", "最初\n追記\n");
  fake.externalCommit({ remove: ["メモA.md"], message: "Delete メモA.md" });
  phone.resolve = (cs) => cs.map((c) => ({ filePath: c.filePath, content: c.localContent }));
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && phone.conflicts[seen] && phone.conflicts[seen].remoteContent === "",
    "the conflict view opens, GitHub side empty");
  check(fake.file("メモA.md") === "最初\n追記\n", "keeping the phone's version puts it back on GitHub");

  section("6. Claude edits a note, the phone moves it before syncing");
  const testNote = "同期テスト.md";
  const tBase = fake.file(testNote);
  fake.externalCommit({ write: { [testNote]: tBase + "\nClaude追記\n" } });
  await move(phone, testNote, "テスト/同期テスト.md");
  r = await phone.sync();
  check(noErrors(r), "no sync error (the original plugin stops here for good)");
  check(fake.file("テスト/同期テスト.md") === tBase, "the moved note is on GitHub");
  check(phone.read(testNote) === tBase + "\nClaude追記\n" && fake.file(testNote) === tBase + "\nClaude追記\n",
    "Claude's version stays too, nothing is lost");
  r = await phone.sync();
  check(noErrors(r), "the next sync is fine as well");

  section("7. Claude edits a note, the phone deletes it before syncing");
  const sad = "同期できない.md";
  const sBase = fake.file(sad);
  fake.externalCommit({ write: { [sad]: sBase + "\nClaude追記\n" } });
  await phone.remove(sad);
  r = await phone.sync();
  check(noErrors(r), "no sync error");
  check(phone.read(sad) === sBase + "\nClaude追記\n", "Claude's newer version comes back instead of being lost");

  section("8. Claude commits while the plugin is committing");
  await phone.edit("日記.md", "iPhoneで書いた\n");
  const zBase = fake.file("README.md");
  fake.once("POST git/trees", () => {
    fake.externalCommit({ write: { "README.md": zBase + "Claude同時\n" } });
  });
  r = await phone.sync();
  check(noErrors(r), "no sync error");
  check(logged(r, "Branch moved during sync, starting over"), "the plugin notices and starts over");
  check(fake.file("README.md") === zBase + "Claude同時\n", "Claude's commit is not reverted");
  check(phone.read("README.md") === zBase + "Claude同時\n", "and arrives on the phone");
  check(fake.file("日記.md") === "iPhoneで書いた\n", "the phone's note is uploaded");

  section("9. An edit is saved while the plugin uploads that note");
  await phone.edit("メモB.md", "v0\n");
  await phone.sync();
  await phone.edit("メモB.md", "v1\n");
  let reads = 0;
  phone.vault.onReadBinary = (p) => {
    // 1st and 2nd reads hash the file, the 3rd one is the upload
    if (p === "メモB.md" && ++reads === 3) {
      fs.writeFileSync(path.join(phone.root, "メモB.md"), "v2\n");
      phone.vault.emit("modify", new obsidian.TFile("メモB.md"));
    }
  };
  r = await phone.sync();
  phone.vault.onReadBinary = null;
  check(noErrors(r) && reads >= 3, "upload done (GitHub has the version read)");
  r = await phone.sync();
  check(noErrors(r) && fake.file("メモB.md") === "v2\n", "the next sync uploads the newer edit");
  check(autofix().length === 0, "no copy or repair needed");

  section("10. Photo and docx made on the phone (iOS can't read them as text)");
  phone.vault.writeFile("添付/写真.png", PNG);
  phone.vault.writeFile("資料/文書.docx", DOCX);
  await phone.vault.flush();
  await phone.edit("写真メモ.md", "今日の写真\n![[写真.png]]\n");
  r = await phone.sync();
  check(noErrors(r), "no sync error (the original plugin fails on both)");
  check(fake.bytes("添付/写真.png") === null, "the photo stays on the phone");
  check(!("添付/写真.png" in fake.manifest().files), "and is not in the remote metadata");
  check(Buffer.compare(fake.bytes("資料/文書.docx") || Buffer.alloc(0), DOCX) === 0, "the docx is uploaded byte for byte");
  check(fake.file("写真メモ.md") === "今日の写真\n![[写真.png]]\n", "the note with the photo is uploaded");
  check(autofix().length === 0, "the auto-fix leaves the photo alone");
  r = await phone.sync();
  check(noErrors(r) && Buffer.compare(readBytes(phone, "添付/写真.png"), PNG) === 0, "the photo is still on the phone");

  section("11. Claude adds an image, then the phone deletes it");
  fake.externalCommit({ write: { "Claude画像/図.png": PNG2 }, message: "Add Claude画像/図.png" });
  r = await phone.sync();
  check(noErrors(r) && Buffer.compare(readBytes(phone, "Claude画像/図.png") || Buffer.alloc(0), PNG2) === 0,
    "the image arrives byte for byte");
  await phone.remove("Claude画像/図.png");
  r = await phone.sync();
  check(noErrors(r) && fake.bytes("Claude画像/図.png") === null, "deleting it on the phone deletes it on GitHub");

  section("12. A file removed outside Obsidian (no delete event)");
  fs.rmSync(path.join(phone.root, "GitHub.md"));
  r = await phone.sync();
  check(noErrors(r), "no sync error");
  check(fake.file("GitHub.md") !== null, "nothing is deleted on GitHub because of it");
  fake.externalCommit({ write: { "GitHub.md": "Claudeが更新\n" } });
  r = await phone.sync();
  check(noErrors(r) && phone.read("GitHub.md") === "Claudeが更新\n", "a newer GitHub version brings it back");

  section("13. With the auto-fix in the loop");
  fake.externalCommit({ write: { "医学メモ/高ナトリウム血症.md": "# 高ナトリウム血症\n" } });
  autofix();
  const hyperKNow = fake.file(hyperK);
  fake.externalCommit({ write: { [hyperK]: hyperKNow + "- もう一行\n" } });
  autofix();
  r = await phone.sync();
  check(noErrors(r) && phone.read("医学メモ/高ナトリウム血症.md") === "# 高ナトリウム血症\n", "new note arrives");
  check(phone.read(hyperK) === hyperKNow + "- もう一行\n", "edit arrives");
  check(autofix().length === 0, "nothing left for the auto-fix");

  section("14. Obsidian-only use");
  await phone.edit("買い物.md", "牛乳\n");
  await phone.sync();
  await move(phone, "買い物.md", "メモ/買い物.md");
  await phone.sync();
  await phone.edit("メモ/買い物.md", "牛乳\n卵\n");
  await phone.sync();
  await phone.remove("メモ/買い物.md");
  r = await phone.sync();
  check(noErrors(r) && fake.file("メモ/買い物.md") === null && fake.file("買い物.md") === null,
    "create, move, edit and delete all reach GitHub");
  check(autofix().length === 0, "the auto-fix stays out of the way");

  section("15. Conflict handling set to Overwrite local / Overwrite remote");
  const mode = "同期テスト.md";
  let mBase = fake.file(mode);
  fake.externalCommit({ write: { [mode]: mBase + "GitHub側\n" } });
  await phone.edit(mode, mBase + "iPhone側\n");
  phone.settings.conflictHandling = "overwriteLocal";
  r = await phone.sync();
  check(noErrors(r) && phone.read(mode) === mBase + "GitHub側\n" && fake.file(mode) === mBase + "GitHub側\n",
    "Overwrite local: GitHub's version wins on both sides");
  mBase = fake.file(mode);
  fake.externalCommit({ write: { [mode]: mBase + "GitHub側2\n" } });
  await phone.edit(mode, mBase + "iPhone側2\n");
  phone.settings.conflictHandling = "overwriteRemote";
  r = await phone.sync();
  check(noErrors(r) && fake.file(mode) === mBase + "iPhone側2\n" && phone.read(mode) === mBase + "iPhone側2\n",
    "Overwrite remote: the phone's version wins on both sides");
  phone.settings.conflictHandling = "ask";

  section("Final state");
  r = await phone.sync();
  check(noErrors(r) && logged(r, "Nothing to sync"), "nothing left to sync");
  let same = true;
  for (const p of git(remote, ["ls-tree", "-r", "--name-only", "-z", "main"]).toString("utf8").split("\0")) {
    if (!p || p.split("/").some((s) => s.startsWith("."))) continue;
    const a = readBytes(phone, p), b = fake.bytes(p);
    if (!a || Buffer.compare(a, b) !== 0) { same = false; console.log(`        differs: ${p}`); }
  }
  check(same, "every file on GitHub matches the phone");
  const extra = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(phone.root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(rel);
      else if (fake.bytes(rel) === null) extra.push(rel);
    }
  };
  walk("");
  check(extra.length === 1 && extra[0] === "添付/写真.png", `only the photo is phone-only (${extra.join(", ")})`);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
