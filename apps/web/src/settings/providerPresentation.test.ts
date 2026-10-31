import { expect, it } from "vite-plus/test";
import { codexFixture } from "../../test/providerFixtures.ts";
import {
  providerEmail,
  providerStatus,
  relativeChecked,
} from "./providerPresentation.ts";
import {
  formatLaunchArguments,
  parseLaunchArguments,
} from "./launchArguments.ts";

it("uses auth-aware status and account labels without reporting stale auth as ready", () => {
  const provider = {
    ...codexFixture,
    account: {
      email: "test@example.com",
      label: "ChatGPT Pro 100 Subscription",
    },
  };
  expect(providerStatus(provider)).toBe(
    "Authenticated · ChatGPT Pro 100 Subscription",
  );
  expect(providerEmail(provider)).toBe("test@example.com");
  expect(providerEmail({ ...provider, status: "checking" })).toBeUndefined();
  expect(providerStatus({ ...provider, status: "checking" })).toBe("Checking…");
  expect(
    providerStatus({
      ...provider,
      config: { ...provider.config, enabled: false },
    }),
  ).toBe("Disabled");
  expect(
    providerStatus({
      ...provider,
      auth: "unauthenticated",
      status: "needs-auth",
    }),
  ).toBe("Not authenticated");
});

it("formats the latest provider check as relative time", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  expect(relativeChecked(null, now)).toBe("Not checked");
  expect(relativeChecked("2026-10-31T11:59:59Z", now)).toBe("Checked just now");
  expect(relativeChecked("2026-10-31T11:57:00Z", now)).toBe("Checked 3m ago");
  expect(relativeChecked("2026-10-31T09:00:00Z", now)).toBe("Checked 3h ago");
});

it("round-trips native launch arguments without shell expansion", () => {
  const args = [
    "--flag",
    "value with spaces",
    "",
    "$(do-not-run)",
    'quote" and \\ slash',
    "~/directory",
  ];
  expect(parseLaunchArguments(formatLaunchArguments(args))).toEqual(args);
  expect(parseLaunchArguments("--flag 'two words' --literal=$HOME")).toEqual([
    "--flag",
    "two words",
    "--literal=$HOME",
  ]);
  expect(() => parseLaunchArguments('--flag "unclosed')).toThrow();
});
