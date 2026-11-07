const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const {
  withAndroidManifest,
  withDangerousMod,
} = require("expo/config-plugins");

module.exports = (config) => {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application[0];
    application.$["android:icon"] = "@drawable/paws_icon";
    delete application.$["android:roundIcon"];

    return mod;
  });

  return withDangerousMod(config, [
    "android",
    (mod) => {
      const destination = path.join(
        mod.modRequest.platformProjectRoot,
        "app/src/main/res/drawable",
      );
      mkdirSync(destination, { recursive: true });
      copyFileSync(
        path.join(mod.modRequest.projectRoot, "assets/icon.xml"),
        path.join(destination, "paws_icon.xml"),
      );

      return mod;
    },
  ]);
};
