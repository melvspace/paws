const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// markdown-it uses Node's historical module name for this pure JS dependency.
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    context,
    moduleName === "punycode" ? "punycode/" : moduleName,
    platform,
  );

module.exports = config;
