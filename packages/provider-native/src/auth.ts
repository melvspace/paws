import { Cursor, FileCredentialStore } from "@cursor/sdk";
import { signInCodex } from "@paws/provider-codex";
import type { ProviderConfig } from "@paws/contracts";
import { providerDriver } from "@paws/provider-core";
import { providerLaunch } from "./launch.ts";

export async function signInProvider(
  config: ProviderConfig,
  cwd: string,
  signal: AbortSignal,
  environment: Record<string, string>,
  onUrl: (url: string, code?: string) => void,
) {
  if (config.driver === "codex") {
    await signInCodex(providerLaunch(config, cwd, signal, environment), onUrl);
  } else if (config.driver === "cursor") {
    // The SDK persists credentials in its native store; no token is sent to the UI.
    const launch = providerLaunch(config, cwd, signal, environment);
    await Cursor.auth.login({
      store: new FileCredentialStore(launch.env?.PAWS_CURSOR_AUTH_FILE),
      openBrowser: false,
      onLoginUrl: (url) => onUrl(url),
      signal,
      apiKeyName: "Paws",
    });
  } else {
    throw new Error(
      `Use ${providerDriver(config.driver).name}'s native sign-in.`,
    );
  }
}
