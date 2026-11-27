// Startup and return-to-app syncs in the patched main.ts.
const fs = require("fs"); const os = require("os"); const path = require("path");
const obsidian = require("./obsidian-mock");

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}

const listeners = {};
const bodyClasses = new Set();
const bodyStyle = {};
global.document = {
  visibilityState: "visible",
  addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
  body: {
    classList: {
      toggle(c, on) { if (on) bodyClasses.add(c); else bodyClasses.delete(c); },
      remove(c) { bodyClasses.delete(c); },
    },
    style: {
      setProperty(k, v) { bodyStyle[k] = v; },
      removeProperty(k) { delete bodyStyle[k]; },
    },
  },
};
function setVisibility(state) {
  document.visibilityState = state;
  for (const cb of listeners.visibilitychange || []) cb();
}

async function load(settings) {
  for (const k of Object.keys(listeners)) delete listeners[k];
  bodyClasses.clear();
  for (const k of Object.keys(bodyStyle)) delete bodyStyle[k];
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
  check(t.plugin.settings.smallPhotos === true && t.plugin.settings.smallPhotoHeight === 160 &&
    t.plugin.settings.openPhotosWithOneTap === true,
    "and photos in notes are shown 160 pixels high and open with one tap");
  check(bodyClasses.has("ggs-small-photos") && bodyStyle["--ggs-small-photo-height"] === "160px",
    "photos are shown small as soon as the plugin loads");
  check((listeners.click || []).length === 1, "and taps on them are listened to");
  await t.plugin.onunload();
  check(!bodyClasses.has("ggs-small-photos") && !("--ggs-small-photo-height" in bodyStyle),
    "when the plugin stops, photos are shown as they were");

  t = await load({ ...configured, smallPhotos: false, smallPhotoHeight: 240 });
  check(!bodyClasses.has("ggs-small-photos"), "Show photos small OFF: photos are shown as they are");
  t.plugin.settings.smallPhotos = true;
  t.plugin.photoView.apply();
  check(bodyClasses.has("ggs-small-photos") && bodyStyle["--ggs-small-photo-height"] === "240px",
    "turned on in the settings: small at once, at the height set");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
