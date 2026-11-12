import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { makeProviderService } from "./ProviderService.ts";
import { makeTextGenerationService } from "./TextGenerationService.ts";

it("selects Luna independently, validates selections and persists explicit choices", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-text-test-");
  const providers = makeProviderService(
    root,
    vi.fn().mockResolvedValue({
      auth: "authenticated",
      version: "1",
      models: [
        { id: "gpt-6-luna", name: "Luna", options: [] },
        { id: "other", name: "Other", options: [] },
      ],
    }),
    undefined,
    undefined,
    (driver) => driver === "codex",
  );
  let service = makeTextGenerationService(root, providers);

  try {
    const provider = providers.list()[0]!;
    await providers.refresh(provider.config.id);
    expect(service.read()).toEqual({ selection: null });
    expect(service.selection()?.modelId).toBe("gpt-6-luna");
    await expect(
      Effect.runPromise(
        service.configure({
          selection: {
            providerId: provider.config.id,
            modelId: "missing",
            options: {},
          },
        }),
      ),
    ).rejects.toThrow();
    const selection = {
      providerId: provider.config.id,
      modelId: "other",
      options: {},
    };
    await Effect.runPromise(service.configure({ selection }));
    service.close();
    service = makeTextGenerationService(root, providers);
    expect(service.selection()).toEqual(selection);
    await Effect.runPromise(service.configure({ selection: null }));
    expect(service.selection()?.modelId).toBe("gpt-6-luna");
  } finally {
    service.close();
    await providers.close();
    await rm(root, { recursive: true, force: true });
  }
});
