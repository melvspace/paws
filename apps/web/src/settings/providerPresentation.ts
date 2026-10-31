import type { ProviderSnapshot } from "@paws/contracts";

export function providerEmail(provider: ProviderSnapshot): string | undefined {
  if (
    !provider.config.enabled ||
    ["checking", "missing", "error"].includes(provider.status) ||
    provider.auth !== "authenticated"
  )
    return undefined;

  return provider.account?.email;
}

export function providerStatus(provider: ProviderSnapshot): string {
  if (!provider.config.enabled) return "Disabled";
  if (provider.status === "checking") return "Checking…";
  if (provider.status === "missing") return "Not installed";
  if (provider.status === "error") return "Check failed";
  if (provider.auth === "authenticated") {
    return provider.account?.label
      ? `Authenticated · ${provider.account.label}`
      : "Authenticated";
  }
  if (provider.auth === "unauthenticated") return "Not authenticated";

  return provider.status === "ready" ? "Ready" : "Not checked";
}

export function relativeChecked(checkedAt: string | null, now: number): string {
  if (!checkedAt) return "Not checked";

  const seconds = Math.max(0, Math.floor((now - Date.parse(checkedAt)) / 1000));

  if (!Number.isFinite(seconds)) return "Checked unavailable";
  if (seconds < 60) return "Checked just now";
  if (seconds < 3600) return `Checked ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Checked ${Math.floor(seconds / 3600)}h ago`;

  return `Checked ${Math.floor(seconds / 86400)}d ago`;
}
