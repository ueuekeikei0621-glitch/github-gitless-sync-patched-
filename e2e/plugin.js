// Loads a module of the plugin as built by transpile.js.
const path = require("path");

const build = process.env.PLUGIN_BUILD || path.join(__dirname, ".build");
module.exports = (name) => require(path.join(build, "src", name));
