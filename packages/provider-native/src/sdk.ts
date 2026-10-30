import {
  query,
  type ModelInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { type SDKModel } from "@cursor/sdk";
import { spawnMspConnection } from "@muse-code/sdk";
import { ProviderModel, type ProviderOption } from "@paws/contracts";
import { Schema } from "effect";
import { fileURLToPath } from "node:url";
import { selectOption } from "@paws/provider-core";
import { runCommand, type ProbeLaunch } from "@paws/provider-core/process";
import { museModels } from "./catalogs.ts";

export function claudeModel(model: ModelInfo): ProviderModel {
  const options: ProviderOption[] = [];

  if (model.supportsEffort && model.supportedEffortLevels?.length) {
    options.push(
      selectOption("effort", "Effort", model.supportedEffortLevels, "high"),
    );
  }

  if (model.supportsFastMode) {
    options.push({
      id: "fastMode",
      label: "Fast mode",
      choices: [
        { id: "false", label: "Standard" },
        { id: "true", label: "Fast" },
      ],
      defaultValue: "false",
    });
  }

  return { id: model.value, name: model.displayName, options };
}

export async function discoverClaude(launch: ProbeLaunch) {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  launch.signal.addEventListener("abort", abort, { once: true });
  const prompt: AsyncIterable<SDKUserMessage> = {
    // oxlint-disable-next-line require-yield -- an empty prompt stream prevents inference during discovery.
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (abortController.signal.aborted) resolve();
        else
          abortController.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      // No user prompt is ever yielded during discovery.
    },
  };
  const session = query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: launch.command,
      abortController,
      cwd: launch.cwd,
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      env: {
        ...(launch.env ?? process.env),
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      },
      stderr: () => {},
    },
  });

  try {
    const [models, account] = await Promise.all([
      session.supportedModels(),
      session.accountInfo(),
    ]);
    const auth =
      account.tokenSource || account.apiKeySource || account.email
        ? ("authenticated" as const)
        : ("unknown" as const);

    return {
      auth,
      account: {
        ...(account.email ? { email: account.email } : {}),
        ...(account.subscriptionType
          ? { label: account.subscriptionType }
          : {}),
      },
      models: models.map(claudeModel),
    };
  } finally {
    launch.signal.removeEventListener("abort", abort);
    abort();
    session.close();
  }
}

export function cursorModel(model: SDKModel): ProviderModel {
  const defaults =
    model.variants?.find((variant) => variant.isDefault)?.params ?? [];
  const options = (model.parameters ?? [])
    .map((parameter): ProviderOption => ({
      id:
        parameter.id === "context"
          ? "contextWindow"
          : parameter.id === "fast"
            ? "fastMode"
            : parameter.id,
      label: parameter.displayName || parameter.id,
      choices: parameter.values.map((choice) => ({
        id: choice.value,
        label: choice.displayName || choice.value,
      })),
      defaultValue:
        defaults.find((value) => value.id === parameter.id)?.value ??
        parameter.values[0]?.value ??
        "",
    }))
    .filter((option) => option.choices.length > 0);

  return { id: model.id, name: model.displayName, options };
}

export async function discoverCursor(launch: ProbeLaunch) {
  const result = await runCommand({
    ...launch,
    command: process.execPath,
    args: [fileURLToPath(new URL("./cursor-probe.ts", import.meta.url))],
  });

  return Schema.decodeUnknownSync(
    Schema.Struct({
      auth: Schema.Literals(["authenticated", "unauthenticated"]),
      models: Schema.Array(ProviderModel),
    }),
  )(JSON.parse(result));
}

export async function discoverMuse(launch: ProbeLaunch) {
  const handshake = spawnMspConnection({
    command: launch.command,
    args: [
      ...launch.args,
      "serve",
      "--disable-shell",
      "--disable-write",
      "--no-session-log",
    ],
    cwd: launch.cwd,
    env: { ...(launch.env ?? process.env), MUSE_NO_AUTO_UPDATE: "1" },
    shutdownTimeoutMs: 1000,
  });
  const abort = () => {
    void handshake.close();
  };
  launch.signal.addEventListener("abort", abort, { once: true });

  try {
    const host = await handshake.initialize({
      clientInfo: { name: "paws", title: "Paws", version: "1" },
      capabilities: { requestedCapabilities: [] },
    });
    const result = await host.connection.request("model/list", {});

    // Muse catalog access alone does not establish authentication (same as T3).
    return { auth: "unknown" as const, models: museModels(result) };
  } finally {
    launch.signal.removeEventListener("abort", abort);
    await handshake.close();
  }
}
