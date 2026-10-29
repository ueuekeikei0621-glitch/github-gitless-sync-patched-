// Startup and return-to-app syncs in the patched main.ts.
const fs = require("fs"); const os = require("os"); const path = require("path");
const obsidian = require("./obsidian-mock");

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}

const listeners = {};
global.document = {
  visibilityState: "visible",
  addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
};
function setVisibility(state) {
  document.visibilityState = state;
  for (const cb of listeners.visibilitychange || []) cb();
}

async function load(settings) {
  for (const k of Object.keys(listeners)) delete listeners[k];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "main-test-"));
  let ready = null;
  const app = {
    vault: new obsidian.Vault(root),
    workspace: {
      onLayoutReady(cb) { ready = cb; },
      on() { return {}; },
      getLeavesOfType() { return []; },
      getActiveFile() { return null; },
    },
    data: settings,
  };
  const Plugin = require("./plugin")("main").default;
  const plugin = new Plugin(app, { id: "github-gitless-sync" });
  await plugin.onload();
  let syncs = 0;
  plugin.sync = async () => { syncs++; };
  await ready();
  return { plugin, syncs: () => syncs };
}

const configured = {
  githubToken: "t", githubOwner: "o", githubRepo: "r", githubBranch: "main",
  firstSync: false, syncStrategy: "manual",
};

(async () => {
  let t = await load({ ...configured, syncOnStartup: true });
  check(t.syncs() === 1, "Sync on startup ON: syncs once the layout is ready");
  setVisibility("hidden");
  setVisibility("visible");
  check(t.syncs() === 1, "coming back within 10 seconds does not sync again");
  t.plugin.lastAutoSync = 0;
  setVisibility("hidden");
  check(t.syncs() === 1, "going to the background does not sync");
  setVisibility("visible");
  check(t.syncs() === 2, "coming back later syncs");

  t = await load({ ...configured, syncOnStartup: false });
  setVisibility("hidden"); setVisibility("visible");
  check(t.syncs() === 0, "Sync on startup OFF: never syncs on its own");

  t = await load({ syncOnStartup: true, githubToken: "" });
  check(t.syncs() === 0, "not configured yet: no sync");

  t = await load({ ...configured, syncOnStartup: true, firstSync: true });
  check(t.syncs() === 0, "first sync pending: left to the user");

  t = await load({ ...configured, syncOnStartup: true });
  check(t.plugin.settings.keepMediaLocal === true, "old settings get the new media option, on");
  check(t.plugin.settings.mediaExtensions.includes("heic"), "with the default extensions");
  check(t.plugin.settings.releaseMedia === true && t.plugin.settings.downloadReleaseMedia === true,
    "and videos and audio sync through the release");
  check(t.plugin.settings.releaseExtensions.includes("mov") && !t.plugin.settings.releaseExtensions.includes("png"),
    "for video and audio extensions only");
  check(t.plugin.settings.releaseMaxSizeMB === 100, "up to 100 MB");
  check(t.plugin.settings.shrinkImages === true && t.plugin.settings.imageMaxSide === 2500 &&
    t.plugin.settings.imageQuality === 80, "and new photos shrink to 2500 pixels, JPEG 80%");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
