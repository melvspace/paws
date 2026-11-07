const { withAndroidManifest } = require("expo/config-plugins");

module.exports = (config) =>
  withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const features = manifest["uses-feature"] ?? [];

    for (const name of [
      "android.hardware.camera",
      "android.hardware.camera.autofocus",
    ]) {
      const feature = features.find(
        (entry) => entry.$["android:name"] === name,
      );

      if (feature) feature.$["android:required"] = "false";
      else
        features.push({
          $: { "android:name": name, "android:required": "false" },
        });
    }

    manifest["uses-feature"] = features;

    return mod;
  });
