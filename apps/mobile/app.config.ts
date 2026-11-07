import type { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  const version = config.version!;
  const [major, minor, patch] = version.split(".").map(Number);

  return {
    ...config,
    name: "Paws",
    slug: "paws",
    android: {
      ...config.android,
      versionCode: major! * 1_000_000 + minor! * 1_000 + patch!,
    },
  };
};
