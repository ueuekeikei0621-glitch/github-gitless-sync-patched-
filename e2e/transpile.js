// Builds the plugin sources for the tests: CommonJS, with the Obsidian API
// replaced by obsidian-mock.js.
// Usage: node e2e/transpile.js [src dir] [out dir]   (out dir: $PLUGIN_BUILD or e2e/.build)
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const ts = require(require.resolve("typescript", { paths: [root] }));
const srcDir = path.resolve(process.argv[2] || path.join(root, "src"));
const outDir = path.resolve(
  process.argv[3] || process.env.PLUGIN_BUILD || path.join(__dirname, ".build"),
);
const mock = path.join(__dirname, "obsidian-mock.js");
const zip = require.resolve("@zip.js/zip.js", { paths: [root] });

// Older versions, built for comparison, lack some of these.
const files = [
  "sync-manager.ts",
  "media-sync.ts",
  "image-shrink.ts",
  "image-encode.ts",
  "github/client.ts",
  "metadata-store.ts",
  "events-listener.ts",
  "utils.ts",
  "logger.ts",
  "settings/settings.ts",
  "settings/tab.ts",
  "main.ts",
].filter((file) => fs.existsSync(path.join(srcDir, file)));
for (const file of files) {
  const source = fs.readFileSync(path.join(srcDir, file), "utf8");
  let { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  outputText = outputText
    .replace(/require\("obsidian"\)/g, `require(${JSON.stringify(mock)})`)
    .replace(/require\("@zip\.js\/zip\.js"\)/g, `require(${JSON.stringify(zip)})`)
    .replace(/require\("src\/([^"]+)"\)/g, (_, p) =>
      `require(${JSON.stringify(path.join(outDir, "src", p))})`);
  const dest = path.join(outDir, "src", file.replace(/\.ts$/, ".js"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, outputText);
}

// The conflicts view needs React; no test opens it.
const view = path.join(outDir, "src/views/conflicts-resolution/view.js");
fs.mkdirSync(path.dirname(view), { recursive: true });
fs.writeFileSync(view,
  'exports.CONFLICTS_RESOLUTION_VIEW_TYPE = "conflicts-resolution-view";\n' +
  "exports.ConflictsResolutionView = class {};\n");
console.log(`built ${srcDir} into ${outDir}`);
