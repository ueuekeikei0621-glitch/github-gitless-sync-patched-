// Photos in notes (src/photo-view.ts and styles.css) in headless Chromium, on
// a page laid out like a note in Obsidian 1.15 on a phone: editing view
// (Live Preview) and reading view, with the Obsidian rules that size photos
// and a stand-in for Obsidian's own tap handling, which selects a photo in
// editing view on the first tap and opens it in the lightbox on the next.
// Usage: node e2e/photo-view-test.js   (needs Playwright's Chromium)
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}

// The rules of Obsidian 1.15.1's app.css that size photos in notes
const OBSIDIAN_CSS = `
body { margin: 0; font: 16px/1.5 sans-serif; }
.markdown-source-view.mod-cm6 img.cm-widgetBuffer{display:inline!important;width:0!important;border:0!important;margin:0!important;padding:0!important}
.internal-embed img:not([width]){max-width:100%}
.internal-embed:not(.image-embed){display:block}
.markdown-preview-view img,.markdown-rendered img{max-width:100%}
.markdown-source-view.mod-cm6 img{max-width:100%}
.markdown-source-view.mod-cm6 .cm-content>.image-embed{display:flex}
.cm-content .image-embed{vertical-align:bottom}
.cm-content .image-embed{width:fit-content}
.cm-content .image-embed .image-wrapper{display:flex;position:relative}
.cm-content .image-embed .image-wrapper img:not([width]){width:100%}
.cm-line>.image-embed{position:relative;display:inline-flex}
.cm-line>.image-embed .image-wrapper{display:inline-flex}
.bases-rendered-value img{width:auto;max-height:100%}
.view-content { width: 358px; }
`;

// Photos as Obsidian puts them in a note: id, width x height, where
const PHOTOS = `
<div class="workspace-leaf-content" data-type="markdown"><div class="view-content">
 <div class="markdown-source-view cm-s-obsidian mod-cm6 is-live-preview">
  <div class="cm-editor"><div class="cm-scroller"><div class="cm-sizer">
   <div class="cm-content" contenteditable="true">
    <div class="cm-line">まず、ボードは背中に入れて使います。</div>
    <div class="internal-embed media-embed image-embed is-loaded" tabindex="-1" src="portrait.jpeg" contenteditable="false"><div class="image-wrapper"><img data-photo="lp-portrait" data-size="1406x2500"></div><div class="embed-actions"></div></div>
    <div class="cm-line">文の後ろ<img class="cm-widgetBuffer" aria-hidden="true"><div class="internal-embed media-embed image-embed is-loaded" tabindex="-1" src="wide.jpg" contenteditable="false"><div class="image-wrapper"><img data-photo="lp-wide" data-size="2500x1150"></div></div><img class="cm-widgetBuffer" aria-hidden="true"></div>
    <div class="cm-line"><div class="internal-embed media-embed image-embed is-loaded" tabindex="-1" src="small.png" contenteditable="false"><div class="image-wrapper"><img data-photo="lp-small" data-size="120x90"></div></div></div>
    <div class="cm-line"><div class="internal-embed media-embed image-embed is-loaded" tabindex="-1" src="sized.jpg|300" contenteditable="false"><div class="image-wrapper"><img data-photo="lp-sized" data-size="2500x1150" width="300"></div></div></div>
    <div class="cm-line"><div class="image-embed" tabindex="-1"><div class="image-wrapper"><img data-photo="lp-markdown" data-size="1875x2500"></div></div></div>
    <div class="cm-embed-block cm-callout" contenteditable="false"><div class="callout"><div class="callout-content"><p><span class="internal-embed media-embed image-embed is-loaded" src="in-callout.jpeg"><img data-photo="lp-callout" data-size="1406x2500"></span></p></div></div></div>
   </div>
  </div></div></div>
 </div>
 <div class="markdown-reading-view"><div class="markdown-preview-view markdown-rendered"><div class="markdown-preview-sizer markdown-preview-section">
  <div><p>てんかんの時は<span class="internal-embed media-embed image-embed is-loaded" src="portrait.jpeg"><img data-photo="rv-portrait" data-size="1406x2500"></span></p></div>
  <div><p><img data-photo="rv-external" data-size="870x1882"></p></div>
  <div><div class="internal-embed bases-embed"><div class="bases-view"><div class="bases-rendered-value"><img data-photo="base" data-size="1406x2500"></div></div></div></div>
  <div><div class="internal-embed canvas-embed"><div class="canvas-node"><div class="markdown-rendered"><img data-photo="canvas-embed" data-size="1406x2500"></div></div></div></div>
 </div></div></div>
</div></div>
<div class="workspace-leaf-content" data-type="canvas"><div class="markdown-rendered"><img data-photo="canvas" data-size="1406x2500"></div></div>
`;

async function main() {
  const source = fs.readFileSync(path.join(root, "src/photo-view.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");

  const browser = await chromium.launch();
  console.log(`Chromium ${browser.version()}`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(`<html><head><style>${OBSIDIAN_CSS}</style><style>${styles}</style></head>` +
    `<body class="is-mobile is-phone">${PHOTOS}</body></html>`);
  await page.addScriptTag({ content: `var exports = {}; var require = () => ({});\n${outputText}` });

  // Pictures of the given sizes, and Obsidian's tap handling as in 1.15
  await page.evaluate(async () => {
    const loads = [];
    for (const img of document.querySelectorAll("img[data-size]")) {
      const [w, h] = img.dataset.size.split("x").map(Number);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").fillRect(0, 0, w, h);
      loads.push(new Promise((resolve) => { img.onload = resolve; }));
      img.src = canvas.toDataURL("image/png");
    }
    await Promise.all(loads);

    window.opened = []; // photos the lightbox opened, in order
    window.openOnFirstTap = false; // an Obsidian that opens on the first tap
    const open = (img) => {
      window.opened.push(img.dataset.photo);
      const box = document.body.appendChild(document.createElement("div"));
      box.className = "lightbox";
    };
    let selected = null;
    for (const img of document.querySelectorAll(".cm-content .image-wrapper > img")) {
      const embed = img.closest(".image-embed");
      img.addEventListener("click", (evt) => {
        if (evt.defaultPrevented) return;
        if (selected === embed || window.openOnFirstTap) { open(img); return; }
        selected?.classList.remove("is-selected");
        selected = embed;
        embed.classList.add("is-selected");
      });
    }
    document.querySelector(".markdown-preview-sizer").addEventListener("click", (evt) => {
      if (evt.target.tagName === "IMG") open(evt.target);
    });
    window.closeLightbox = () => document.querySelectorAll(".lightbox").forEach((el) => el.remove());
    window.deselect = () => { selected?.classList.remove("is-selected"); selected = null; };

    // The plugin, as main.ts starts it
    window.settings = { smallPhotos: true, smallPhotoHeight: 160, openPhotosWithOneTap: true };
    const plugin = { registerDomEvent: (el, type, cb, opts) => el.addEventListener(type, cb, opts) };
    window.photoView = new exports.default(plugin, () => window.settings);
    window.photoView.start();
  });

  const size = (photo) => page.evaluate((photo) => {
    const r = document.querySelector(`[data-photo="${photo}"]`).getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }, photo);
  const near = (a, b) => Math.abs(a - b) <= 1;
  // Waits for the tap's handlers, and the one passed on after it
  const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  const opened = () => page.evaluate(() => window.opened.slice());
  const reset = () => page.evaluate(() => { window.opened = []; window.closeLightbox(); window.deselect(); });
  const isSelected = (photo) => page.evaluate((photo) =>
    document.querySelector(`[data-photo="${photo}"]`).closest(".image-embed").classList.contains("is-selected"), photo);

  console.log("Shown small (160 pixels):");
  let s = await size("lp-portrait");
  check(s.h === 160 && near(s.w, 90), `editing view, a portrait photo on its own line: 90 x 160 (${s.w} x ${s.h})`);
  s = await size("lp-wide");
  check(s.h <= 160 && s.w <= 358 && near(s.w / s.h, 2500 / 1150) && s.w >= 300,
    `a wide photo after text keeps its shape within the line (${s.w} x ${s.h})`);
  s = await size("lp-small");
  check(s.w === 120 && s.h === 90, `a photo smaller than that stays as it is (${s.w} x ${s.h})`);
  s = await size("lp-sized");
  check(s.w === 300, `a size written in the link is kept (${s.w} wide)`);
  s = await size("lp-markdown");
  check(s.h === 160 && near(s.w, 120), `a photo linked the Markdown way: 120 x 160 (${s.w} x ${s.h})`);
  s = await size("lp-callout");
  check(s.h === 160, `a photo in a callout (${s.w} x ${s.h})`);
  s = await size("rv-portrait");
  check(s.h === 160 && near(s.w, 90), `reading view: 90 x 160 (${s.w} x ${s.h})`);
  s = await size("rv-external");
  check(s.h === 160 && near(s.w, 74), `reading view, a picture from the web (${s.w} x ${s.h})`);
  const buffers = await page.evaluate(() =>
    [...document.querySelectorAll("img.cm-widgetBuffer")].map((img) => img.getBoundingClientRect().width));
  check(buffers.every((w) => w === 0), "the editor's own invisible images are left alone");
  s = await size("canvas");
  check(s.w > 300, `a picture in a canvas is left alone (${s.w} x ${s.h})`);
  s = await size("canvas-embed");
  check(s.w > 300, `and in a canvas embedded in the note (${s.w} x ${s.h})`);
  s = await size("base");
  check(s.w > 300, `and in a base embedded in the note (${s.w} x ${s.h})`);
  const cursor = await page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-photo="lp-portrait"]')).cursor);
  check(cursor === "zoom-in", "the pointer shows they open bigger");

  await page.evaluate(() => { window.settings.smallPhotoHeight = 100; window.photoView.apply(); });
  s = await size("lp-portrait");
  check(s.h === 100 && near(s.w, 56), `another height: 56 x 100 (${s.w} x ${s.h})`);

  await page.evaluate(() => { window.settings.smallPhotos = false; window.photoView.apply(); });
  s = await size("lp-portrait");
  check(s.w === 358 && s.h > 600, `turned off: as wide as the note again (${s.w} x ${s.h})`);
  s = await size("rv-portrait");
  check(s.w === 358, `in reading view too (${s.w} x ${s.h})`);
  await page.evaluate(() => { window.settings = { smallPhotos: true, smallPhotoHeight: 160, openPhotosWithOneTap: true }; window.photoView.apply(); });

  console.log("Opened with one tap:");
  await page.tap('[data-photo="lp-portrait"]');
  await settle();
  check(JSON.stringify(await opened()) === '["lp-portrait"]', "editing view: the first tap opens the photo, once");
  check(await isSelected("lp-portrait"), "Obsidian selected it on the way, as it does");
  await page.evaluate(() => window.closeLightbox());
  await page.tap('[data-photo="lp-portrait"]');
  await settle();
  check(JSON.stringify(await opened()) === '["lp-portrait","lp-portrait"]',
    "tapped again once closed: Obsidian opens it, and only Obsidian");
  await reset();

  await page.click('[data-photo="lp-wide"]');
  await settle();
  check(JSON.stringify(await opened()) === '["lp-wide"]', "a click (iPad with a trackpad, desktop) opens it too");
  await reset();

  await page.tap('[data-photo="lp-portrait"]');
  await settle();
  await page.evaluate(() => window.closeLightbox());
  await page.tap('[data-photo="lp-wide"]');
  await settle();
  check(JSON.stringify(await opened()) === '["lp-portrait","lp-wide"]',
    "another photo, while the first is still selected, opens with one tap");
  await reset();

  await page.tap('[data-photo="lp-markdown"]');
  await settle();
  check(JSON.stringify(await opened()) === '["lp-markdown"]', "a photo linked the Markdown way");
  await reset();

  await page.tap('[data-photo="rv-portrait"]');
  await settle();
  check(JSON.stringify(await opened()) === '["rv-portrait"]', "reading view: Obsidian opens it on the first tap, once");
  await reset();

  await page.tap('[data-photo="lp-callout"]');
  await settle();
  check((await opened()).length === 0, "a photo the editor doesn't select (in a callout) is left to Obsidian");
  await reset();

  await page.click('[data-photo="lp-portrait"]', { modifiers: ["Control"] });
  await settle();
  check((await opened()).length === 0 && await isSelected("lp-portrait"), "a click with Ctrl or Cmd is left to Obsidian");
  await reset();

  await page.evaluate(() => { window.openOnFirstTap = true; });
  await page.tap('[data-photo="lp-wide"]');
  await settle();
  check(JSON.stringify(await opened()) === '["lp-wide"]',
    "an Obsidian that opens photos on the first tap opens them once");
  await page.evaluate(() => { window.openOnFirstTap = false; });
  await reset();

  await page.evaluate(() => { window.settings.openPhotosWithOneTap = false; });
  await page.tap('[data-photo="lp-portrait"]');
  await settle();
  check((await opened()).length === 0 && await isSelected("lp-portrait"),
    "\"Open a photo with one tap\" off: the first tap only selects it, as before");
  await reset();

  await page.evaluate(() => window.photoView.stop());
  const left = await page.evaluate(() => [document.body.className, document.body.style.cssText]);
  check(left[0] === "is-mobile is-phone" && left[1] === "", "when the plugin stops, nothing of it is left on the page");
  s = await size("lp-portrait");
  check(s.w === 358, `and photos are as wide as the note (${s.w} x ${s.h})`);

  await browser.close();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
