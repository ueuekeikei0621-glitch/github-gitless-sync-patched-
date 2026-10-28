// End-to-end scenarios: the real plugin sync + sync_autofix.py on a copy of
// the vault repository, with the 1.0.7 plugin. See README.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, git, MANIFEST } = require("./lib");

const [SOURCE_REPO, SCRIPT] = process.argv.slice(2);
const PHONE_STATE = "6b84df8"; // the plugin's last commit: what the phone holds now

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n== ${title}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-e2e-"));
const remote = path.join(root, "remote.git");
execFileSync("git", ["clone", "--quiet", "--bare", "--no-tags", SOURCE_REPO, remote]);
const head = execFileSync("git", ["-C", SOURCE_REPO, "rev-parse", process.env.BASE || "origin/main"]).toString().trim();
git(remote, ["update-ref", "refs/heads/main", head]);
git(remote, ["config", "uploadpack.allowFilter", "true"]);
const fake = new FakeGitHub(remote);
obsidian.setRequestHandler((req) => fake.handle(req));

// Same kind of clone as the workflow makes.
const work = path.join(root, "work");
execFileSync("git", ["clone", "--quiet", "--filter=blob:none", `file://${remote}`, work]);

function autofix() {
  const out = execFileSync("python3", ["-I", SCRIPT, "--push"], { cwd: work }).toString();
  const lines = out.split("\n").filter(Boolean);
  for (const line of lines) console.log(`        autofix: ${line}`);
  return lines;
}

function blobSha(text) {
  return execFileSync("git", ["hash-object", "--stdin"], { input: Buffer.from(text, "utf8") }).toString().trim();
}

function stamp(commit) {
  const seconds = Number(git(remote, ["log", "-1", "--format=%ct", commit]).toString().trim());
  const jst = new Date((seconds + 9 * 3600) * 1000).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 13)}-${jst.slice(14, 16)}`;
}

function noErrors(result) {
  return !result.notices.some((n) => n.startsWith("Error"));
}

async function main() {
  // The phone as it is now: files and metadata from the plugin's last commit.
  const phone = new Phone(path.join(root, "phone"));
  // The phone holds what the plugin's metadata lists, at the recorded versions.
  const metadata = fake.manifest(PHONE_STATE);
  const files = {};
  for (const [p, entry] of Object.entries(metadata.files)) {
    if (entry.deleted || p.split("/").some((s) => s.startsWith("."))) continue;
    files[p] = git(remote, ["cat-file", "blob", entry.sha]).toString("utf8");
  }
  await phone.init(files, metadata);

  section("0. Plugin alone (today)");
  let r = await phone.sync();
  check(r.log.some((e) => e.message === "Nothing to sync"), "plugin logs 'Nothing to sync'");
  check(phone.read("医学メモ/高カリウム血症.md") === null, "Claude's note does not arrive");
  check(phone.read("同期できない.md") === "悲しい", "the GitHub edit does not arrive");

  section("1. First auto-fix run on the real history");
  let out = autofix();
  check(out.includes("Recorded new file 医学メモ/高カリウム血症.md"), "records Claude's note");
  check(out.includes("Recorded change to 同期できない.md"), "records the GitHub edit");
  check(out.length === 2, "nothing else (no false alarms in the existing history)");
  r = await phone.sync();
  check(noErrors(r), "plugin sync succeeds");
  check(phone.read("医学メモ/高カリウム血症.md") === fake.file("医学メモ/高カリウム血症.md"), "Claude's note arrives");
  check(phone.read("同期できない.md") === "悲しい1234", "the GitHub edit arrives");
  check(!fs.existsSync(path.join(phone.root, ".github")), ".github files stay off the phone");
  check(autofix().length === 0, "a second run changes nothing");

  section("2. Claude adds a note");
  const hypoCa = "医学メモ/低カルシウム血症.md";
  fake.externalCommit({ write: { [hypoCa]: "# 低カルシウム血症\n\n- テタニー\n" }, message: `Add ${hypoCa}` });
  autofix();
  r = await phone.sync();
  check(noErrors(r) && phone.read(hypoCa) === "# 低カルシウム血症\n\n- テタニー\n", "the new note arrives");

  section("3. Claude edits a note the phone did not touch");
  const testNote = "同期テスト.md";
  const edited = fake.file(testNote) + "\nClaudeが追記";
  fake.externalCommit({ write: { [testNote]: edited } });
  autofix();
  r = await phone.sync();
  check(noErrors(r) && phone.read(testNote) === edited, "the edit arrives");

  section("4. Claude and the phone edit the same note");
  const lowNa = "低ナトリウム血症の鑑別と初期対応.md";
  const naBase = fake.file(lowNa);
  fake.externalCommit({ write: { [lowNa]: naBase + "\nClaude追記" } });
  autofix();
  await phone.edit(lowNa, naBase + "\niPhone追記");
  const merged = naBase + "\niPhone追記\nClaude追記";
  phone.resolve = (cs) => cs.map((c) => ({ filePath: c.filePath, content: merged }));
  const seen = phone.conflicts.length;
  r = await phone.sync();
  const conflict = phone.conflicts[seen];
  check(phone.conflicts.length === seen + 1 && conflict.filePath === lowNa, "the plugin shows its conflict view");
  check(conflict && conflict.remoteContent.endsWith("Claude追記") && conflict.localContent.endsWith("iPhone追記"),
    "with both versions");
  check(fake.file(lowNa) === merged && phone.read(lowNa) === merged, "the merged text is saved on both sides");
  check(autofix().length === 0, "no copy for a conflict the user resolved");
  await phone.sync();
  check(autofix().length === 0, "still nothing after the plugin's follow-up sync");

  section("5. The phone overwrites Claude's edit before the auto-fix runs");
  const sad = "同期できない.md";
  const sadBase = fake.file(sad);
  const claudeSad = fake.externalCommit({ write: { [sad]: sadBase + "\nClaudeの行" } });
  await phone.edit(sad, sadBase + "\niPhoneの行");
  await phone.sync();
  check(fake.file(sad) === sadBase + "\niPhoneの行", "(the plugin replaced Claude's version on GitHub)");
  out = autofix();
  const sadCopy = `同期できない（GitHub側の版 ${stamp(claudeSad)}）.md`;
  check(out.some((l) => l.includes(sadCopy)), `auto-fix saves Claude's version as ${sadCopy}`);
  check(fake.file(sadCopy) === sadBase + "\nClaudeの行", "the copy holds Claude's text");
  r = await phone.sync();
  check(noErrors(r) && phone.read(sadCopy) === sadBase + "\nClaudeの行", "the copy arrives on the phone");
  check(phone.read(sad) === sadBase + "\niPhoneの行", "the phone's own edit stays");

  section("6. Claude writes while the plugin is committing (stale-base race)");
  const hyperK = "医学メモ/高カリウム血症.md";
  const kBase = fake.file(hyperK);
  const testBase = fake.file(testNote);
  await phone.edit(testNote, testBase + "\niPhone編集");
  fake.beforeHeadLookup = () => {
    fake.externalCommit({ write: { [hyperK]: kBase + "\nClaude追記(同時)", "医学メモ/同時作成.md": "Claudeが同時に作成\n" } });
  };
  await phone.sync();
  check(fake.file(hyperK) === kBase, "(the plugin's commit reverted Claude's edit)");
  check(fake.file("医学メモ/同時作成.md") === null, "(and dropped Claude's new note)");
  check(fake.file(testNote) === testBase + "\niPhone編集", "(the phone's edit was uploaded)");
  out = autofix();
  check(fake.file(hyperK) === kBase + "\nClaude追記(同時)", "auto-fix puts Claude's edit back");
  check(fake.file("医学メモ/同時作成.md") === "Claudeが同時に作成\n", "auto-fix puts Claude's new note back");
  check(fake.file(testNote) === testBase + "\niPhone編集", "the phone's edit is kept");
  r = await phone.sync();
  check(noErrors(r) && phone.read(hyperK) === kBase + "\nClaude追記(同時)", "the restored edit arrives");
  check(phone.read("医学メモ/同時作成.md") === "Claudeが同時に作成\n", "the restored note arrives");

  section("7. Claude deletes a note the phone did not touch");
  fake.externalCommit({ remove: [hypoCa], message: `Delete ${hypoCa}` });
  autofix();
  r = await phone.sync();
  check(noErrors(r) && phone.read(hypoCa) === null, "the note is deleted on the phone");
  check(autofix().length === 0, "nothing left to fix");

  section("8. Claude deletes a note the phone has edited");
  await phone.edit("メモA.md", "最初の内容\n");
  await phone.sync();
  check(autofix().length === 0, "a note created in Obsidian needs no fix");
  await phone.edit("メモA.md", "最初の内容\niPhoneで追記\n");
  fake.externalCommit({ remove: ["メモA.md"], message: "Delete メモA.md" });
  autofix();
  phone.resolve = (cs) => cs.map((c) => ({ filePath: c.filePath, content: c.localContent }));
  const before8 = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r), "no sync error");
  check(phone.conflicts.length === before8 + 1 && phone.conflicts[before8].remoteContent === "",
    "the conflict view opens (GitHub side shown empty)");
  check(fake.file("メモA.md") === "最初の内容\niPhoneで追記\n", "keeping the phone's version restores it on GitHub");

  section("9. A note the plugin claims to have uploaded but did not (plugin quirk)");
  const memoB = "メモB.md";
  await phone.edit(memoB, "v0\n");
  await phone.sync();
  await phone.edit(memoB, "v1\n");
  let armed = true;
  phone.vault.onRead = (p) => {
    if (armed && p === memoB) {
      armed = false; // Obsidian saves a newer edit while the plugin is uploading
      fs.writeFileSync(path.join(phone.root, memoB), "v2\n");
      phone.vault.emit("modify", new obsidian.TFile(memoB));
    }
  };
  await phone.sync();
  phone.vault.onRead = null;
  check(fake.file(memoB) === "v1\n" && fake.manifest().files[memoB].sha === blobSha("v2\n"),
    "(GitHub got v1, the plugin's metadata says v2)");
  const claudeB = fake.externalCommit({ write: { [memoB]: "v1\nClaude\n" } });
  out = autofix();
  const copyB = `メモB（GitHub側の版 ${stamp(claudeB)}）.md`;
  check(out.some((l) => l.includes(copyB)), "auto-fix saves Claude's version as a copy instead");
  r = await phone.sync();
  check(noErrors(r) && phone.read(memoB) === "v2\n", "the unsynced phone text is not overwritten");
  check(phone.read(copyB) === "v1\nClaude\n", "Claude's version arrives as the copy");
  await phone.edit(memoB, "v3\n");
  await phone.sync();
  check(fake.file(memoB) === "v3\n", "the next edit uploads normally");
  check(autofix().length === 0, "no duplicate copy afterwards");

  section("10. Obsidian-only use");
  await phone.edit("日記.md", "今日は晴れ\n");
  await phone.sync();
  await phone.edit("日記.md", "今日は晴れ\n追記\n");
  await phone.sync();
  await phone.remove("日記.md");
  await phone.sync();
  check(autofix().length === 0, "auto-fix stays out of the way");

  section("11. Claude renames a note");
  const kText = fake.file(hyperK);
  fake.externalCommit({ write: { "医学メモ/高K血症.md": kText }, remove: [hyperK], message: "Rename" });
  autofix();
  r = await phone.sync();
  check(noErrors(r) && phone.read("医学メモ/高K血症.md") === kText && phone.read(hyperK) === null,
    "the phone follows the rename");

  section("12. A plugin sync that started before the auto-fix commits on top of it");
  const xBase = fake.file(testNote);
  fake.externalCommit({ write: { [testNote]: xBase + "\nClaude最後" } });
  await phone.edit("日記2.md", "別のメモ\n"); // gives the plugin something to commit
  fake.beforeHeadLookup = () => { autofix(); }; // the auto-fix lands mid-sync
  await phone.sync();
  check(fake.manifest().files[testNote].sha === blobSha(xBase), "(the plugin's commit undid the auto-fix record)");
  out = autofix();
  check(out.length === 1 && out[0] === `Recorded change to ${testNote}`, "the next run records it again");
  r = await phone.sync();
  check(noErrors(r) && phone.read(testNote) === xBase + "\nClaude最後", "and the edit arrives");

  section("Final state");
  check(autofix().length === 0, "auto-fix has nothing left to do");
  const manifest = fake.manifest();
  check(!Object.keys(manifest.files).some((p) => p.startsWith(".github/")), "no .github paths in the metadata");
  let same = true;
  for (const p of git(remote, ["ls-tree", "-r", "--name-only", "-z", "main"]).toString("utf8").split("\0")) {
    if (!p || p.split("/").some((s) => s.startsWith("."))) continue;
    if (phone.read(p) !== fake.file(p)) { same = false; console.log(`        differs: ${p}`); }
  }
  check(same, "every note on GitHub matches the phone");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
