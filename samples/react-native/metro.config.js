// Resolve @subetha/sdk and @subetha/react-native from this repo's sources (TypeScript, no build
// step). A standalone app would instead `npm install @subetha/react-native`.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const repo = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.join(repo, "sdk/js"), path.join(repo, "sdk/react-native")];
config.resolver.extraNodeModules = {
  "@subetha/sdk": path.join(repo, "sdk/js/src/index.ts"),
  "@subetha/react-native": path.join(repo, "sdk/react-native/src/index.ts"),
};
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];

module.exports = config;
