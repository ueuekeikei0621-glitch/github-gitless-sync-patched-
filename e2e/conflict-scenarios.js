// Notes changed both on the phone and on GitHub: a note Obsidian only
// reformatted is no conflict, and "Overwrite local file" keeps the phone's
// version when it has real edits. Starts from an empty repository.
// Usage: node e2e/conflict-scenarios.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, Phone, MANIFEST } = require("./lib");

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
function section(title) { console.log(`\n== ${title}`); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-e2e-"));
const remote = path.join(root, "remote.git");
execFileSync("git", ["init", "--quiet", "--bare", remote]);
const fake = new FakeGitHub(remote);
obsidian.setRequestHandler((req) => fake.handle(req));

const noErrors = (r) => !r.notices.some((n) => n.startsWith("Error"));
const logged = (r, message) => r.log.some((e) => e.message === message);
const same = (a, b) => !!a && !!b && Buffer.compare(a, b) === 0;
function readBytes(phone, p) {
  const full = path.join(phone.root, p);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
}
// The versions of p kept on the phone, as <name>（端末の版 <date>）
function copiesOf(phone, p) {
  const dir = path.dirname(p) === "." ? "" : `${path.dirname(p)}/`;
  const stem = path.basename(p, path.extname(p));
  return fs.readdirSync(path.join(phone.root, dir))
    .filter((n) => n.startsWith(`${stem}（端末の版 `) && n.endsWith(`）${path.extname(p)}`))
    .map((n) => dir + n).sort();
}
// Runs fn with the vault events of its writes held back until it's done, like
// an Obsidian that reports a new file only after the sync has finished
async function withLateEvents(phone, fn) {
  const emit = phone.vault.emit;
  const held = [];
  phone.vault.emit = (name, file) => { held.push([name, file]); };
  try {
    return await fn();
  } finally {
    phone.vault.emit = emit;
    for (const [name, file] of held) phone.vault.emit(name, file);
    await phone.vault.flush();
  }
}

// A note with a table as Claude writes it, and as Obsidian leaves it once a
// cell is touched
const table = (rows, memo) =>
  `# 買い物\n\n|品目|数|店|\n|---|--:|:-:|\n${rows.map((r) => `|${r.join("|")}|\n`).join("")}\n${memo}\n`;
const padded = (rows, memo) =>
  "# 買い物\n\n| 品目   |   数 |  店  |\n| ---- | --: | :-: |\n" +
  `${rows.map((r) => `| ${r[0].padEnd(4)} | ${r[1].padStart(3)} | ${r[2]}  |\n`).join("")}\n${memo}\n`;
const ROWS = [["牛乳", "2", "A"], ["卵", "10", "B"]];
const MORE = [...ROWS, ["パン", "1", "A"]];

function formattingCases() {
  const { differOnlyByFormatting } = require("./plugin")("utils");
  const T = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  const cases = [
    // [formatting only?, one version, the other, what it shows]
    [true, "|a|b|\n|---|---|\n|1|2|\n", "| a   | b   |\n| --- | --- |\n| 1   | 2   |\n", "a table padded to align its columns"],
    [true, table(ROWS, "メモ"), padded(ROWS, "メモ"), "the same with wide characters and aligned columns"],
    [true, "|a|b|c|\n|-|:-|--:|\n", "| a | b | c |\n| ----- | :---- | ----: |\n", "delimiter rows of any length"],
    [true, "|a|b|\n|:-:|---|\n", "|a|b|\n| :---: | - |\n", "a centred column, still centred"],
    [false, "|a|b|\n|---|---|\n|1|2|\n", "|a|b|\n|:--|---|\n|1|2|\n", "an alignment colon added"],
    [false, "|a|b|\n|--:|---|\n", "|a|b|\n|:-:|---|\n", "an alignment changed"],
    [false, T, "| a | b |\n| --- | --- |\n| 1 | 3 |\n", "the text of a cell changed"],
    [false, "| a b | c |\n|---|---|\n", "| a  b | c |\n|---|---|\n", "spaces inside the text of a cell changed"],
    [false, T, "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n", "a row added"],
    [false, "|a|b|\n|---|---|\n|1|\n", "|a|b|\n|---|---|\n|1| |\n", "a cell added to a row"],
    [true, "a | b\n--- | ---\n1 | 2\n", T, "pipes at both ends, or not"],
    [true, "|a|b\n|-|-\n|1|2\n", "a|b|\n-|-|\n1|2|\n", "or at one end only"],
    [true, "|a\\|b|c|\n|---|---|\n", "| a\\|b | c   |\n| ---- | --- |\n", "an escaped pipe stays in its cell"],
    [false, "|a\\|b|c|\n|---|---|\n", "|a\\| b|c|\n|---|---|\n", "and a space next to it is text"],
    [false, "|a\\|b|\n|---|\n", "|a|b|\n|---|\n", "an escaped pipe is not a cell separator"],
    [true, "> [!note]- 表\n> |a|b|\n> |---|---|\n> |1|2|\n", "> [!note]- 表\n> | a   | b   |\n> | --- | --- |\n> | 1   | 2   |\n", "a table in a callout"],
    [true, "> > |a|b|\n> > |-|-|\n", "> > | a | b |\n> > | --- | --- |\n", "in a nested quote"],
    [true, "- 項目\n  |a|b|\n  |---|---|\n  |1|2|\n", "- 項目\n  | a   | b   |\n  | --- | --- |\n  | 1   | 2   |\n", "an indented table"],
    [true, "|a|b|\n|-|-|\n|1|2|\n\n本文\n\n|c|\n|-|\n|3|\n", "| a | b |\n| - | - |\n| 1\t|\t2 |\n\n本文\n\n| c   |\n| --- |\n| 3   |\n", "two tables in a note, tabs around a cell"],
    [false, "  |a|b|\n  |---|---|\n  |1|2|\n", "    |a|b|\n    |---|---|\n    |1|2|\n", "the indentation of a table changed"],
    [false, "> |a|b|\n> |---|---|\n> |1|2|\n", ">|a|b|\n>|---|---|\n>|1|2|\n", "the quote markers of a table changed"],
    [false, "> |a|b|\n> |---|---|\n> |1|2|\n", "> |a|b|\n> |---|---|\n| 1 | 2 |\n", "a row taken out of its callout"],
    [false, "|a|b|\n|---|---|\n|1|2|\n", "|a|b|\n|---|---|\n\n|1|2|\n", "a blank line put inside a table"],
    [false, "```\n|a|b|\n|---|---|\n```\n", "```\n| a | b |\n| --- | --- |\n```\n", "table-like lines in a code block"],
    [false, "~~~text\n|a|b|\n|---|---|\n~~~\n", "~~~text\n| a | b |\n| --- | --- |\n~~~\n", "in a ~~~ code block"],
    [false, "> ```\n> |a|b|\n> |---|---|\n> ```\n", "> ```\n> | a | b |\n> | --- | --- |\n> ```\n", "in a code block in a callout"],
    [false, "- ```\n  |a|b|\n  |---|---|\n  ```\n", "- ```\n  | a | b |\n  | --- | --- |\n  ```\n", "in a code block opened on a list item"],
    [false, "````\n```\n|a|b|\n|---|---|\n```\n````\n", "````\n```\n| a | b |\n| --- | --- |\n```\n````\n", "in a code block showing a code block"],
    [false, "```\n|a|b|\n|---|---|\n", "```\n| a | b |\n| --- | --- |\n", "in a code block that is never closed"],
    [true, "```\nx | y\n```\n\n|a|b|\n|---|---|\n", "```\nx | y\n```\n\n| a | b |\n| --- | --- |\n", "a table after a code block"],
    [true, "a  \nb\t\n", "a\nb\n", "spaces and tabs at the end of lines"],
    [true, "a\nb", "a\nb\n\n\n", "newlines at the end of the file"],
    [true, "a\r\n|x|y|\r\n|---|---|\r\n", "a\n| x | y |\n| --- | --- |\n", "Windows line endings"],
    [false, "a b\n", "a  b\n", "a space added inside a line of text"],
    [false, "a | b\n", "a  |  b\n", "spaces around a pipe that is in no table"],
    [false, "a | b\n\n---|---\n", "a  |  b\n\n---|---\n", "a row with no delimiter row right after it"],
    [false, "|a|b|\n|---|\n", "| a | b |\n|---|\n", "a delimiter row with fewer cells than the row before"],
    [false, "a\n b\n", "a\nb\n", "indentation removed"],
    [false, "a\n\nb\n", "a\nb\n", "a blank line removed between two lines"],
    [false, "　a\n", "a\n", "a full-width space removed"],
    [true, "", "\n", "an empty note"],
  ];
  for (const [expected, a, b, what] of cases) {
    check(differOnlyByFormatting(a, b) === expected && differOnlyByFormatting(b, a) === expected,
      `${expected ? "formatting" : "an edit  "}: ${what}`);
  }
}

async function main() {
  section("0. What counts as formatting");
  formattingCases();

  // A phone whose first sync fills the repository
  const phone = new Phone(path.join(root, "phone"));
  await phone.init({
    "買い物.md": table(ROWS, "メモ"),
    "予定.md": table(ROWS, "メモ"),
    "日記.md": "一日目\n",
    "記録.md": "一行目\n",
    "下書き.md": "最初の版\n",
    "相談.md": "最初の版\n",
    "表.txt": table(ROWS, "メモ"),
    "古い場所/一覧.md": table(ROWS, "メモ"),
    ".隠し/設定.md": "最初の版\n",
  }, { lastSync: 0, files: {} });
  phone.vault.iosLike = true;
  await phone.manager.firstSync();
  let r = await phone.sync();
  check(noErrors(r) && fake.file("買い物.md") === table(ROWS, "メモ") && logged(r, "Nothing to sync"), "the phone's notes are on GitHub");

  section("1. Ask: Obsidian realigns a table, Claude edits the note");
  await phone.edit("買い物.md", padded(ROWS, "メモ"));
  fake.externalCommit({ write: { "買い物.md": table(MORE, "メモ：パンも") } });
  let seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && phone.conflicts.length === seen, "the conflict view doesn't open");
  check(phone.read("買い物.md") === table(MORE, "メモ：パンも") && fake.file("買い物.md") === table(MORE, "メモ：パンも"),
    "the phone takes Claude's version, which stays on GitHub");
  check(copiesOf(phone, "買い物.md").length === 0 && logged(r, "Only reformatted locally"), "without keeping a copy");
  let head = fake.head();
  r = await phone.sync();
  check(noErrors(r) && logged(r, "Nothing to sync") && fake.head() === head, "the next sync has nothing to do");

  section("2. Overwrite local file: the same");
  phone.settings.conflictHandling = "overwriteLocal";
  await phone.edit("予定.md", padded(ROWS, "メモ"));
  fake.externalCommit({ write: { "予定.md": table(MORE, "メモ") } });
  r = await phone.sync();
  check(noErrors(r) && phone.read("予定.md") === table(MORE, "メモ") && fake.file("予定.md") === table(MORE, "メモ"),
    "the phone takes Claude's version");
  check(copiesOf(phone, "予定.md").length === 0 && r.notices.length === 2, `no copy, no word about it (${r.notices.join(" / ")})`);

  section("3. Overwrite local file: the phone and Claude both edit a note");
  await phone.edit("日記.md", "一日目\niPhoneで書いた\n");
  fake.externalCommit({ write: { "日記.md": "一日目\nClaudeが書いた\n" } });
  r = await phone.sync();
  check(noErrors(r) && phone.read("日記.md") === "一日目\nClaudeが書いた\n" && fake.file("日記.md") === "一日目\nClaudeが書いた\n",
    "Claude's version wins on both sides");
  let copies = copiesOf(phone, "日記.md");
  check(copies.length === 1 && /^日記（端末の版 \d{4}-\d{2}-\d{2} \d{2}-\d{2}）\.md$/.test(copies[0]),
    `the phone's version is kept next to it (${copies.join(", ")})`);
  const diary = copies[0];
  check(phone.read(diary) === "一日目\niPhoneで書いた\n" && fake.file(diary) === "一日目\niPhoneで書いた\n",
    "with the phone's text, and it's on GitHub after that same sync");
  check(r.notices.some((n) => n.includes("日記.md") && n.includes(diary)), "a notice names it");
  check(phone.meta(diary).sha === fake.blobOf(diary) && fake.manifest().files[diary]?.sha === fake.blobOf(diary),
    "recorded as uploaded, here and in the remote metadata");
  head = fake.head();
  r = await phone.sync();
  check(noErrors(r) && logged(r, "Nothing to sync") && fake.head() === head, "the next sync has nothing to do");
  await phone.edit(diary, "一日目\niPhoneで書いた\n続き\n");
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && fake.file(diary) === "一日目\niPhoneで書いた\n続き\n" && copiesOf(phone, diary).length === 0 &&
    phone.conflicts.length === seen, "the kept version is a note like any other: an edit to it just goes up");

  section("4. The same when Obsidian reports the new file late");
  await phone.edit("記録.md", "一行目\niPhoneの行\n");
  fake.externalCommit({ write: { "記録.md": "一行目\nClaudeの行\n" } });
  r = await withLateEvents(phone, () => phone.sync());
  copies = copiesOf(phone, "記録.md");
  check(noErrors(r) && phone.read("記録.md") === "一行目\nClaudeの行\n" && copies.length === 1 &&
    fake.file(copies[0]) === "一行目\niPhoneの行\n", "the phone's version is kept and uploaded");
  check(phone.meta(copies[0]).sha === fake.blobOf(copies[0]), "and still recorded as uploaded once the event has come");
  await phone.edit(copies[0], "一行目\niPhoneの行\n続き\n");
  r = await phone.sync();
  check(noErrors(r) && fake.file(copies[0]) === "一行目\niPhoneの行\n続き\n" && copiesOf(phone, copies[0]).length === 0,
    "so an edit to it goes up, with no conflict");

  section("5. The app died after saving the phone's version, before the download");
  await phone.edit("下書き.md", "最初の版\niPhoneの版\n");
  fake.externalCommit({ write: { "下書き.md": "最初の版\nClaudeの版\n" } });
  // What the sync that died left: the copy on disk, nothing recorded
  const left = "下書き（端末の版 2026-01-02 03-04）.md";
  fs.writeFileSync(path.join(phone.root, left), "最初の版\niPhoneの版\n");
  r = await phone.sync();
  copies = copiesOf(phone, "下書き.md");
  check(noErrors(r) && phone.read("下書き.md") === "最初の版\nClaudeの版\n", "the next sync downloads Claude's version");
  check(copies.length === 1 && copies[0] === left, `without saving the phone's version again (${copies.join(", ")})`);
  check(fake.file(left) === "最初の版\niPhoneの版\n", "and uploads the copy that was left");
  r = await phone.sync();
  check(noErrors(r) && logged(r, "Nothing to sync"), "the next sync has nothing to do");

  section("6. A commit lands while that sync commits, then both edit again");
  await phone.edit("相談.md", "最初の版\niPhoneの版\n");
  fake.externalCommit({ write: { "相談.md": "最初の版\nClaudeの版\n" } });
  fake.once("POST git/trees", () => {
    fake.externalCommit({ write: { "別のメモ.md": "Claudeが同時に書いた\n" } });
  });
  r = await phone.sync();
  copies = copiesOf(phone, "相談.md");
  check(noErrors(r) && logged(r, "Branch moved during sync, starting over") && phone.read("別のメモ.md") === "Claudeが同時に書いた\n",
    "the sync starts over on top of it");
  check(copies.length === 1 && fake.file(copies[0]) === "最初の版\niPhoneの版\n" && phone.read("相談.md") === "最初の版\nClaudeの版\n",
    "and still keeps one copy, uploaded");
  await phone.edit("相談.md", "最初の版\nClaudeの版\niPhoneの二回目\n");
  fake.externalCommit({ write: { "相談.md": "最初の版\nClaudeの版\nClaudeの二回目\n" } });
  r = await phone.sync();
  copies = copiesOf(phone, "相談.md");
  check(noErrors(r) && copies.length === 2 && copies.every((c) => fake.file(c) === phone.read(c)) &&
    copies.map((c) => phone.read(c)).sort().join() === ["最初の版\niPhoneの版\n", "最初の版\nClaudeの版\niPhoneの二回目\n"].sort().join(),
    `a second version, even in the same minute, gets a copy of its own (${copies.join(", ")})`);
  // Another device has just uploaded its own version, under the name this
  // minute gives
  await phone.edit("相談.md", "iPhoneの三回目\n");
  const now = new Date();
  const two = (n) => `${n}`.padStart(2, "0");
  const theirs = `相談（端末の版 ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}-${two(now.getMinutes())} 3）.md`;
  fake.externalCommit({ write: { "相談.md": "Claudeの三回目\n", [theirs]: "iPadの版\n" } });
  r = await phone.sync();
  copies = copiesOf(phone, "相談.md");
  check(noErrors(r) && fake.file(theirs) === "iPadの版\n" && phone.read(theirs) === "iPadの版\n" &&
    copies.filter((c) => fake.file(c) === "iPhoneの三回目\n" && phone.read(c) === "iPhoneの三回目\n").length === 1,
    `a version another device saved under the same name is left alone (${copies.join(", ")})`);

  section("7. Overwrite local file: nothing to keep when nothing is overwritten");
  await phone.edit("消える.md", "最初の版\n");
  await phone.sync();
  await phone.edit("消える.md", "最初の版\niPhoneの版\n");
  fake.externalCommit({ remove: ["消える.md"], message: "Delete 消える.md" });
  r = await phone.sync();
  check(noErrors(r) && phone.read("消える.md") === "最初の版\niPhoneの版\n" && copiesOf(phone, "消える.md").length === 0,
    "a note Claude deleted while the phone edited it stays as it is, as before");
  await phone.remove("消える.md");
  // A hidden file only syncs through the metadata, as another device records it
  const hidden = ".隠し/設定.md";
  fake.externalCommit({ write: { [hidden]: "Claudeの版\n" } });
  const manifest = fake.manifest();
  manifest.files[hidden] = { ...manifest.files[hidden], sha: fake.blobOf(hidden), lastModified: Date.now() };
  fake.externalCommit({ write: { [MANIFEST]: JSON.stringify(manifest) }, message: "Sync" });
  fs.writeFileSync(path.join(phone.root, hidden), "iPhoneの版\n");
  r = await phone.sync();
  check(noErrors(r) && phone.read(hidden) === "Claudeの版\n" && fs.readdirSync(path.join(phone.root, ".隠し")).length === 1,
    "a hidden file is overwritten without a copy, as before");

  section("8. Overwrite local file: files iOS can't read as text");
  const DOCX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0xff, 0xfe, 0x80, 0x81, 0xc3, 0x28]);
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  const edited = (data, byte) => Buffer.concat([data, Buffer.from([0x00, byte])]);
  fake.externalCommit({ write: { "資料/文書.docx": DOCX, "添付/図.png": PNG }, message: "Add a document and a picture" });
  r = await phone.sync();
  check(noErrors(r) && same(readBytes(phone, "資料/文書.docx"), DOCX) && same(readBytes(phone, "添付/図.png"), PNG), "a document and a picture arrive");
  phone.vault.writeFile("資料/文書.docx", edited(DOCX, 0xf1));
  phone.vault.writeFile("添付/図.png", edited(PNG, 0xf1));
  await phone.vault.flush();
  fake.externalCommit({ write: { "資料/文書.docx": edited(DOCX, 0xf2), "添付/図.png": edited(PNG, 0xf2) }, message: "Edit both" });
  r = await phone.sync();
  check(noErrors(r) && same(readBytes(phone, "資料/文書.docx"), edited(DOCX, 0xf2)) && same(readBytes(phone, "添付/図.png"), edited(PNG, 0xf2)),
    "both take the versions on GitHub");
  copies = copiesOf(phone, "資料/文書.docx");
  check(copies.length === 1 && same(readBytes(phone, copies[0]), edited(DOCX, 0xf1)) && same(fake.bytes(copies[0]), edited(DOCX, 0xf1)),
    "the phone's document is kept and uploaded byte for byte");
  copies = copiesOf(phone, "添付/図.png");
  check(copies.length === 1 && same(readBytes(phone, copies[0]), edited(PNG, 0xf1)), "the phone's picture is kept byte for byte");
  check(fake.bytes(copies[0]) === null && !(copies[0] in fake.manifest().files),
    "on the phone only, like any picture made there (Keep media on this device)");
  const kept = copies[0];
  r = await phone.sync();
  check(noErrors(r) && logged(r, "Nothing to sync") && same(readBytes(phone, kept), edited(PNG, 0xf1)), "the next sync has nothing to do");

  section("9. Ask: a real edit still opens the conflict view");
  phone.settings.conflictHandling = "ask";
  await phone.edit("買い物.md", padded(MORE, "メモ：パンも").replace("牛乳", "豆乳"));
  fake.externalCommit({ write: { "買い物.md": table(MORE, "メモ：パンは二つ") } });
  const merged = table(MORE, "メモ：パンは二つ").replace("牛乳", "豆乳");
  phone.resolve = (cs) => cs.map((c) => ({ filePath: c.filePath, content: merged }));
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && phone.conflicts.length === seen + 1 && phone.conflicts[seen].filePath === "買い物.md" &&
    phone.conflicts[seen].localContent.includes("豆乳") && phone.conflicts[seen].remoteContent.includes("パンは二つ"),
    "with both versions");
  check(phone.read("買い物.md") === merged && fake.file("買い物.md") === merged && copiesOf(phone, "買い物.md").length === 0,
    "the merged text is on both sides, and no copy is made");

  section("10. Ask: what is not a note Obsidian reformatted");
  phone.resolve = (cs) => cs.map((c) => ({ filePath: c.filePath, content: c.remoteContent }));
  await phone.edit("表.txt", padded(ROWS, "メモ"));
  fake.externalCommit({ write: { "表.txt": table(MORE, "メモ") } });
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && phone.conflicts.length === seen + 1 && phone.conflicts[seen].filePath === "表.txt",
    "a file that isn't a note is asked about, whatever changed in it");
  // The version last synced can't be fetched
  await phone.edit("予定.md", padded(MORE, "メモ"));
  fake.faults.push({ key: `GET git/blobs/${fake.blobOf("予定.md")}`, status: 500 });
  fake.externalCommit({ write: { "予定.md": table(ROWS, "メモ") } });
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && phone.conflicts.length === seen + 1 && phone.conflicts[seen].filePath === "予定.md" && fake.faults.length === 0,
    "a note whose last synced version can't be read is asked about too");
  check(phone.read("予定.md") === table(ROWS, "メモ"), "and then synced as answered");
  // No version was ever synced: the note is new on both sides
  await phone.edit("新しい表.md", padded(ROWS, "メモ"));
  fake.externalCommit({ write: { "新しい表.md": table(ROWS, "メモ") } });
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && phone.conflicts.length === seen + 1 && phone.conflicts[seen].filePath === "新しい表.md",
    "and so is a note created on both sides, even if only its formatting differs");

  section("11. Any mode: a realigned note that Claude moved goes to its new place");
  for (const mode of ["ask", "overwriteLocal", "overwriteRemote"]) {
    phone.settings.conflictHandling = mode;
    const [from, to] = mode === "ask" ? ["古い場所/一覧.md", "新しい場所/一覧.md"]
      : mode === "overwriteLocal" ? ["新しい場所/一覧.md", "もっと新しい場所/一覧.md"] : ["もっと新しい場所/一覧.md", "最後の場所/一覧.md"];
    await phone.edit(from, padded(ROWS, "メモ"));
    fake.externalCommit({ write: { [to]: table(ROWS, "メモ") }, remove: [from], message: `Move ${from}` });
    seen = phone.conflicts.length;
    r = await phone.sync();
    check(noErrors(r) && phone.conflicts.length === seen && phone.read(from) === null && phone.read(to) === table(ROWS, "メモ") &&
      fake.file(from) === null && !fs.existsSync(path.join(phone.root, path.dirname(from))),
      `${mode}: the old note and its folder go, the moved one arrives, nothing is asked`);
  }

  section("12. Overwrite remote file: a realigned note still takes Claude's version");
  await phone.edit("最後の場所/一覧.md", padded(ROWS, "メモ"));
  fake.externalCommit({ write: { "最後の場所/一覧.md": table(MORE, "メモ") } });
  r = await phone.sync();
  check(noErrors(r) && phone.read("最後の場所/一覧.md") === table(MORE, "メモ") && fake.file("最後の場所/一覧.md") === table(MORE, "メモ"),
    "Claude's edit isn't replaced by the realigned table");
  await phone.edit("最後の場所/一覧.md", table(MORE, "メモ：iPhone"));
  fake.externalCommit({ write: { "最後の場所/一覧.md": table(MORE, "メモ：Claude") } });
  r = await phone.sync();
  check(noErrors(r) && fake.file("最後の場所/一覧.md") === table(MORE, "メモ：iPhone") && copiesOf(phone, "最後の場所/一覧.md").length === 0,
    "a real edit wins as before, and no copy is made");
  phone.settings.conflictHandling = "ask";

  section("Final state");
  seen = phone.conflicts.length;
  r = await phone.sync();
  check(noErrors(r) && logged(r, "Nothing to sync") && phone.conflicts.length === seen, "nothing left to sync");
  const differ = execFileSync("git", ["--git-dir", remote, "-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "-z", "main"])
    .toString("utf8").split("\0").filter((p) => p && !p.startsWith(".obsidian/") && !same(readBytes(phone, p), fake.bytes(p)));
  check(differ.length === 0, `every file on GitHub matches the phone (${differ.join(", ")})`);
  const extra = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(phone.root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel === ".obsidian") continue;
      if (e.isDirectory()) walk(rel);
      else if (fake.bytes(rel) === null) extra.push(rel);
    }
  };
  walk("");
  check(extra.length === 1 && extra[0] === kept, `only the kept picture is phone-only (${extra.join(", ")})`);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${root})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
