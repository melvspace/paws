const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = (config) =>
  withAppBuildGradle(config, (mod) => {
    // Keep the existing application ID and signing keys so installed apps update.
    const start = "// paws-signing-start";
    const end = "// paws-signing-end";
    const existing = mod.modResults.contents.indexOf(start);

    if (existing !== -1) {
      const tail = mod.modResults.contents.indexOf(end, existing);
      mod.modResults.contents =
        mod.modResults.contents.slice(0, existing) +
        mod.modResults.contents.slice(tail + end.length);
    }

    mod.modResults.contents =
      mod.modResults.contents.trimEnd() +
      `
${start}
android {
    signingConfigs {
        debug {
            if (System.getenv('ANDROID_DEBUG_KEYSTORE_FILE')) {
                storeFile file(System.getenv('ANDROID_DEBUG_KEYSTORE_FILE'))
                storePassword System.getenv('ANDROID_DEBUG_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_DEBUG_KEY_ALIAS')
                keyPassword System.getenv('ANDROID_DEBUG_KEY_PASSWORD')
            }
        }
        release {
            if (System.getenv('ANDROID_KEYSTORE_FILE')) {
                storeFile file(System.getenv('ANDROID_KEYSTORE_FILE'))
                storePassword System.getenv('ANDROID_KEYSTORE_PASSWORD')
                keyAlias System.getenv('ANDROID_KEY_ALIAS')
                keyPassword System.getenv('ANDROID_KEY_PASSWORD')
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
// Test APKs also include JavaScript and run without Metro.
react { debuggableVariants = [] }
${end}
`;

    return mod;
  });
