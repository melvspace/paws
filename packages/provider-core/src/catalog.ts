// Registry shape and driver metadata adapted from T3 Code providerClients (MIT).
import type {
  ProviderDriver,
  ProviderModel,
  ProviderOption,
} from "@paws/contracts";

export const providerDrivers: readonly {
  id: ProviderDriver;
  name: string;
  command: string;
  login: string;
  setupUrl: string;
}[] = [
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    login: "codex login",
    setupUrl: "https://github.com/openai/codex",
  },
  {
    id: "claudeAgent",
    name: "Claude",
    command: "claude",
    login: "claude auth login",
    setupUrl: "https://code.claude.com/docs/en/setup",
  },
  {
    id: "cursor",
    name: "Cursor",
    command: "agent",
    login: "",
    setupUrl: "https://cursor.com/docs/cli/overview",
  },
  {
    id: "grok",
    name: "Grok",
    command: "grok",
    login: "grok login",
    setupUrl: "https://grok.com/code",
  },
  {
    id: "fx",
    name: "fx",
    command: "fx",
    login: "fx login",
    setupUrl: "https://github.com/vercel-labs/fx",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    login: "opencode auth login",
    setupUrl: "https://opencode.ai/docs",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    command: "agy_acp_server.par",
    login: "",
    setupUrl: "https://antigravity.google",
  },
  {
    id: "muse",
    name: "Muse Code",
    command: "muse",
    login: "muse login",
    setupUrl: "https://dev.meta.ai/docs/muse-code",
  },
  {
    id: "pi",
    name: "Pi",
    command: "pi",
    login: "pi /login",
    setupUrl: "https://github.com/badlogic/pi-mono",
  },
  {
    id: "acpRegistry",
    name: "ACP Registry",
    command: "",
    login: "",
    setupUrl: "https://agentclientprotocol.com",
  },
];

export function providerDriver(id: ProviderDriver) {
  return providerDrivers.find((driver) => driver.id === id)!;
}

export const effortLabels: Readonly<Record<string, string>> = {
  off: "Off",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  auto: "Auto",
};

export function selectOption(
  id: string,
  label: string,
  values: readonly string[],
  preferred?: string,
): ProviderOption {
  return {
    id,
    label,
    choices: [...new Set(values)].map((value) => ({
      id: value,
      label: effortLabels[value] ?? value,
    })),
    defaultValue: values.includes(preferred ?? "")
      ? preferred!
      : (values[0] ?? ""),
  };
}

// Drop stale options when changing providers/models; keep only advertised native values.
export function normalizeModelOptions(
  model: ProviderModel | undefined,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    (model?.options ?? []).map((option) => [
      option.id,
      option.choices.some((choice) => choice.id === values[option.id])
        ? values[option.id]!
        : option.defaultValue,
    ]),
  );
}

export function modelKey(instanceId: string, modelId: string) {
  return `${instanceId}:${encodeURIComponent(modelId)}`;
}
