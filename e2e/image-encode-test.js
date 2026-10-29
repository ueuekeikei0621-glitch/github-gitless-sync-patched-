// Runs encodeImage (src/image-encode.ts) in headless Chromium on real images
// made with ImageMagick: orientation, size limit, transparency, bad input.
// Usage: node e2e/image-encode-test.js   (needs Playwright's Chromium and ImageMagick)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));

let failures = 0;
function check(cond, message) {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${message}`);
  if (!cond) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-encode-"));
const magick = (...args) => execFileSync("convert", args, { maxBuffer: 1 << 28 });
const file = (name) => path.join(dir, name);
// "<format> <width> <height>" of an image file
const identify = (p) => execFileSync("identify", ["-format", "%m %w %h", p]).toString().trim();
// The colour at x,y as [r, g, b], 0-255
function pixel(p, x, y) {
  const out = execFileSync("convert", [p, "-format", `%[fx:int(255*p{${x},${y}}.r)] %[fx:int(255*p{${x},${y}}.g)] %[fx:int(255*p{${x},${y}}.b)]`, "info:"]).toString();
  return out.trim().split(" ").map(Number);
}
const close = (a, b, tolerance = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

async function main() {
  // A camera photo stored sideways: red on the left, blue on the right, with
  // EXIF orientation 6 ("rotate 90° clockwise to display").
  // (ImageMagick doesn't add the EXIF tag to a file without EXIF; Pillow does)
  execFileSync("python3", ["-c", [
    "import sys; from PIL import Image",
    "im = Image.new('RGB', (4000, 2000), 'red'); im.paste((0, 0, 255), (2000, 0, 4000, 2000))",
    "exif = Image.Exif(); exif[0x0112] = 6",
    "im.save(sys.argv[1], quality=92, exif=exif.tobytes())",
  ].join("\n"), file("sideways.jpg")]);
  // A large photo-like PNG, a transparent PNG, a small JPEG
  magick("-size", "4000x3000", "plasma:", file("photo.png"));
  magick("-size", "3000x2000", "xc:none", "-fill", "red", "-draw", "circle 1500,1000 1500,1600", file("alpha.png"));
  magick("-size", "800x600", "plasma:", "-quality", "92", file("small.jpg"));
  fs.writeFileSync(file("broken.png"), Buffer.from("not an image at all, just text"));

  const source = fs.readFileSync(path.join(root, "src/image-encode.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  await page.addScriptTag({ content: `var exports = {};\n${outputText}` });
  console.log(`Chromium ${browser.version()}`);

  async function encode(name, type, maxSide = 2500, quality = 80) {
    const b64 = fs.readFileSync(file(name)).toString("base64");
    const result = await page.evaluate(async ({ b64, type, maxSide, quality }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const r = await exports.encodeImage(bytes.buffer, type, maxSide, quality);
      if (r === null) return null;
      let s = "";
      const out = new Uint8Array(r.data);
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return { b64: btoa(s), width: r.width, height: r.height };
    }, { b64, type, maxSide, quality });
    if (result === null) return null;
    const out = file(`${name}.q${quality}.out.jpg`);
    fs.writeFileSync(out, Buffer.from(result.b64, "base64"));
    return { ...result, path: out, size: fs.statSync(out).size };
  }

  const sideways = await encode("sideways.jpg", "image/jpeg");
  check(sideways && identify(sideways.path) === "JPEG 1250 2500", `a sideways photo comes out upright, 2500 high (${sideways && identify(sideways.path)})`);
  check(sideways && close(pixel(sideways.path, 625, 300), [255, 0, 0]) && close(pixel(sideways.path, 625, 2200), [0, 0, 255]),
    "turned the right way: red on top, blue below");

  const photo = await encode("photo.png", "image/png");
  const pngSize = fs.statSync(file("photo.png")).size;
  check(photo && identify(photo.path) === "JPEG 2500 1875" && photo.width === 2500 && photo.height === 1875,
    `a 4000×3000 PNG becomes a 2500×1875 JPEG (${photo && identify(photo.path)})`);
  check(photo && photo.size < pngSize / 4, `much smaller: ${(pngSize / 1e6).toFixed(1)} MB → ${(photo.size / 1e6).toFixed(2)} MB`);

  const alpha = await encode("alpha.png", "image/png");
  check(alpha && identify(alpha.path) === "JPEG 2500 1667", `a transparent PNG is scaled too (${alpha && identify(alpha.path)})`);
  check(alpha && close(pixel(alpha.path, 5, 5), [255, 255, 255], 8) && close(pixel(alpha.path, 1250, 833), [255, 0, 0]),
    "transparent areas become white, the rest keeps its colour");

  const small = await encode("small.jpg", "image/jpeg");
  check(small && identify(small.path) === "JPEG 800 600", "a small photo isn't enlarged");

  const low = await encode("photo.png", "image/png", 2500, 40);
  check(low && photo && low.size < photo.size * 0.8, `lower quality gives a smaller file (${(low.size / 1e6).toFixed(2)} MB at 40%)`);

  check((await encode("broken.png", "image/png")) === null, "what isn't an image gives null");

  await browser.close();
  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}  (work dir: ${dir})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
