// First sync of the patched plugin: an empty repository from a vault with
// notes and a photo, and a new device from the existing vault repository.
// Usage: node e2e/first-sync-test.js <vault repo>
const fs = require("fs"); const os = require("os"); const path = require("path");
const { execFileSync } = require("child_process");
const obsidian = require("./obsidian-mock");
const { FakeGitHub, git } = require("./lib");

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001", "hex");

async function plugin(root, settings) {
  const SyncManager = require("./plugin")("sync-manager").default;
  const Logger = require("./plugin")("logger").default;
  const { DEFAULT_SETTINGS } = require("./plugin")("settings/settings");
  const vault = new obsidian.Vault(root);
  vault.iosLike = true;
  const logger = new Logger(vault, true);
  await logger.init();
  const all = Object.assign({}, DEFAULT_SETTINGS, {
    githubToken: "t", githubOwner: "ueuekeikei0621-glitch", githubRepo: "obsidian-",
    githubBranch: "main", firstSync: true,
  }, settings);
  const manager = new SyncManager(vault, all, async () => [], logger);
  await manager.loadMetadata();
  manager.startEventsListener({ registerEvent() {} });
  await vault.flush();
  return { vault, manager };
}

function log(root) {
  return fs.readFileSync(path.join(root, ".obsidian/github-sync.log"), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l).message);
}

(async () => {
  console.log("== First sync into an empty repository");
  let root = fs.mkdtempSync(path.join(os.tmpdir(), "first-local-"));
  let remote = path.join(root, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  let fake = new FakeGitHub(remote);
  obsidian.setRequestHandler((req) => fake.handle(req));
  const vaultDir = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultDir, "フォルダ"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "添付"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "ノート1.md"), "一つ目\n");
  fs.writeFileSync(path.join(vaultDir, "フォルダ/ノート2.md"), "二つ目\n");
  fs.writeFileSync(path.join(vaultDir, "添付/写真.png"), PNG);
  let p = await plugin(vaultDir, {});
  await p.manager.firstSync();
  check(fake.file("ノート1.md") === "一つ目\n" && fake.file("フォルダ/ノート2.md") === "二つ目\n", "notes uploaded");
  check(fake.bytes("添付/写真.png") === null, "photo stays on the device");
  const m = fake.manifest();
  check(!("添付/写真.png" in m.files) && "ノート1.md" in m.files, "metadata lists the notes, not the photo");
  await p.manager.sync();
  check(log(vaultDir).includes("Nothing to sync"), "the next sync has nothing to do");

  console.log("\n== First sync of a new device from the vault repository");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "first-remote-"));
  remote = path.join(root, "remote.git");
  execFileSync("git", ["clone", "--quiet", "--bare", "--no-tags", process.argv[2], remote]);
  git(remote, ["update-ref", "refs/heads/main",
    execFileSync("git", ["-C", process.argv[2], "rev-parse", "origin/main"]).toString().trim()]);
  fake = new FakeGitHub(remote);
  obsidian.setRequestHandler((req) => fake.handle(req));
  const newDevice = path.join(root, "ipad");
  fs.mkdirSync(newDevice, { recursive: true });
  p = await plugin(newDevice, {});
  await p.manager.firstSync();
  let same = true;
  for (const f of git(remote, ["ls-tree", "-r", "--name-only", "-z", "main"]).toString("utf8").split("\0")) {
    if (!f || f.split("/").some((s) => s.startsWith("."))) continue;
    const local = path.join(newDevice, f);
    if (!fs.existsSync(local) || Buffer.compare(fs.readFileSync(local), fake.bytes(f)) !== 0) {
      same = false; console.log(`        differs: ${f}`);
    }
  }
  check(same, "every note arrives");
  check(!fs.existsSync(path.join(newDevice, ".github")), ".github stays in the repository");
  check(!Object.keys(fake.manifest().files).some((f) => f.startsWith(".github")), "and out of the metadata");
  await p.manager.sync();
  check(log(newDevice).includes("Nothing to sync"), "the next sync has nothing to do");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
