// Resolve @subetha/sdk and @subetha/react-native (and their /edge entry points) from this repo's
// sources (TypeScript, no build step). A standalone app would instead
// `npm install @subetha/react-native`.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const repo = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);

const aliases = {
  "@subetha/sdk": path.join(repo, "sdk/js/src/index.ts"),
  "@subetha/sdk/edge": path.join(repo, "sdk/js/src/edge/index.ts"),
  "@subetha/react-native": path.join(repo, "sdk/react-native/src/index.ts"),
  "@subetha/react-native/edge": path.join(repo, "sdk/react-native/src/edge.ts"),
};

config.watchFolders = [path.join(repo, "sdk/js"), path.join(repo, "sdk/react-native")];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
config.resolver.resolveRequest = (context, moduleName, platform) =>
  aliases[moduleName]
    ? { type: "sourceFile", filePath: aliases[moduleName] }
    : context.resolveRequest(context, moduleName, platform);

module.exports = config;
