import * as Fs from "node:fs/promises";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { makeProviderService as makeService } from "./ProviderService.ts";
import { ProbeError } from "@paws/provider-core/process";
import type { ProviderDiscovery } from "@paws/provider-native";

const installed = (driver: string) => ["codex", "claudeAgent"].includes(driver);
const makeProviderService: typeof makeService = (
  root,
  discover,
  onChange,
  authenticate,
) => makeService(root, discover, onChange, authenticate, installed);

const discovered: ProviderDiscovery = {
  auth: "authenticated",
  version: "1.2.3",
  models: [{ id: "test-model", name: "Test", options: [] }],
};

async function tempRoot() {
  await Fs.mkdir("/tmp/codex", { recursive: true });

  return Fs.mkdtemp("/tmp/codex/paws-providers-");
}

it("persists instances and write-only environment values; removing all stays empty after restart", async () => {
  const root = await tempRoot();
  const discovery = vi.fn().mockResolvedValue(discovered);
  let service = makeProviderService(root, discovery);

  try {
    expect(service.list()).toHaveLength(2);
    const created = await Effect.runPromise(service.create("claudeAgent"));
    await Effect.runPromise(
      service.setEnvironment(created.config.id, {
        name: "ANTHROPIC_API_KEY",
        value: "fake-secret-test-only",
      }),
    );
    await service.refresh(created.config.id);
    expect(discovery.mock.calls[0]?.[3]).toEqual({
      ANTHROPIC_API_KEY: "fake-secret-test-only",
    });
    expect(JSON.stringify(service.list())).not.toContain(
      "fake-secret-test-only",
    );
    expect(
      service
        .list()
        .find((provider) => provider.config.id === created.config.id)
        ?.environment,
    ).toEqual(["ANTHROPIC_API_KEY"]);
    await service.close();
    service = makeProviderService(root, discovery);
    expect(
      service
        .list()
        .find((provider) => provider.config.id === created.config.id)?.config
        .driver,
    ).toBe("claudeAgent");

    for (const provider of service.list())
      await Effect.runPromise(service.remove(provider.config.id));
    await service.close();
    service = makeProviderService(root, discovery);
    expect(service.list()).toEqual([]);
  } finally {
    await service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("coalesces probes and refuses stale results after a disable or deletion", async () => {
  const root = await tempRoot();
  let finish: (value: ProviderDiscovery) => void = () => {};
  const discovery = vi.fn(
    () =>
      new Promise<ProviderDiscovery>((resolve) => {
        finish = resolve;
      }),
  );
  const service = makeProviderService(root, discovery);

  try {
    const first = service.refresh("codex");
    const second = service.refresh("codex");
    expect(first).toBe(second);
    expect(discovery).toHaveBeenCalledTimes(1);
    const config = service
      .list()
      .find((provider) => provider.config.id === "codex")!.config;
    await Effect.runPromise(
      service.update("codex", { ...config, enabled: false }),
    );
    finish(discovered);
    await first;
    expect(
      service.list().find((provider) => provider.config.id === "codex"),
    ).toMatchObject({ status: "disabled", models: [] });
    await service.refresh("codex");
    expect(discovery).toHaveBeenCalledTimes(1);
    await Effect.runPromise(
      service.update("codex", { ...config, enabled: true }),
    );
    const pending = service.refresh("codex");
    await Effect.runPromise(service.remove("codex"));
    finish(discovered);
    await pending;
    expect(
      service.list().some((provider) => provider.config.id === "codex"),
    ).toBe(false);
  } finally {
    await service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("clears an authoritative empty or unauthenticated catalog and sanitizes failures", async () => {
  const root = await tempRoot();
  const discovery = vi
    .fn()
    .mockResolvedValueOnce(discovered)
    .mockResolvedValueOnce({ ...discovered, models: [] })
    .mockResolvedValueOnce({ ...discovered, auth: "unauthenticated" })
    .mockRejectedValueOnce(new Error("do-not-expose-secret"))
    .mockRejectedValueOnce(new ProbeError("missing", "missing"));
  const service = makeProviderService(root, discovery);

  try {
    expect((await service.refresh("codex"))?.models).toHaveLength(1);
    expect((await service.refresh("codex"))?.models).toEqual([]);
    expect(await service.refresh("codex")).toMatchObject({
      status: "needs-auth",
      models: [],
    });
    expect(JSON.stringify(await service.refresh("codex"))).not.toContain(
      "do-not-expose-secret",
    );
    expect((await service.refresh("codex"))?.status).toBe("missing");
  } finally {
    await service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps sign-in URLs ephemeral and rejects callbacks after cancellation", async () => {
  const root = await tempRoot();
  const discovery = vi.fn().mockResolvedValue(discovered);
  let emit: (url: string, code?: string) => void = () => {};
  const authenticate = vi.fn(
    async (
      _config,
      _cwd,
      signal: AbortSignal,
      _environment,
      onUrl: (url: string, code?: string) => void,
    ) => {
      emit = onUrl;
      onUrl("https://example.com/sign-in", "TEST-CODE");
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  );
  const service = makeProviderService(root, discovery, () => {}, authenticate);

  try {
    service.startSignIn("codex");
    await vi.waitFor(() =>
      expect(service.list()[0]?.signIn?.phase).toBe("waiting"),
    );
    await service.refresh("codex");
    expect(discovery).not.toHaveBeenCalled();
    service.cancelSignIn("codex");
    emit("https://example.com/late-callback", "LATE");
    expect(service.list()[0]?.signIn).toBeUndefined();
    expect(discovery).not.toHaveBeenCalled();
  } finally {
    await service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("seeds only installed drivers and keeps explicitly added providers for setup", async () => {
  const root = await tempRoot();
  const discovery = vi.fn().mockResolvedValue(discovered);
  let service = makeProviderService(root, discovery);

  try {
    expect(service.list().map((provider) => provider.config.driver)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    const added = await Effect.runPromise(service.create("grok"));
    expect(
      service.list().some((provider) => provider.config.id === added.config.id),
    ).toBe(true);
    await service.close();
    service = makeProviderService(root, discovery);
    expect(
      service.list().some((provider) => provider.config.id === added.config.id),
    ).toBe(true);
  } finally {
    await service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("hides legacy uninstalled defaults without hiding configured instances", async () => {
  const root = await tempRoot();
  const discovery = vi.fn().mockResolvedValue(discovered);
  let service = makeService(root, discovery, undefined, undefined, () => true);

  try {
    const grok = service
      .list()
      .find((provider) => provider.config.id === "grok")!;
    await service.close();
    service = makeProviderService(root, discovery);
    expect(service.list().map((provider) => provider.config.driver)).toEqual([
      "codex",
      "claudeAgent",
    ]);
    await Effect.runPromise(
      service.update("grok", { ...grok.config, binaryPath: "/custom/grok" }),
    );
    expect(
      service.list().some((provider) => provider.config.id === "grok"),
    ).toBe(true);
  } finally {
    await service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
