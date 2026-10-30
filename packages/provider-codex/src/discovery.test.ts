import { expect, it } from "vite-plus/test";
import { codexModel, discoverCodex } from "./discovery.ts";
import * as Fs from "node:fs/promises";

it("exposes only advertised reasoning and service tiers using native IDs", () => {
  const model = codexModel({
    model: "test",
    displayName: "Test",
    supportedReasoningEfforts: [{ reasoningEffort: "high" }],
    defaultReasoningEffort: "high",
    serviceTiers: [{ id: "priority", name: "Fast" }],
    defaultServiceTier: "priority",
  });
  expect(model.options.map((option) => option.id)).toEqual([
    "reasoningEffort",
    "serviceTier",
  ]);
  expect(model.options[1]?.defaultValue).toBe("priority");
  expect(
    codexModel({
      model: "plain",
      displayName: "Plain",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium",
    }).options,
  ).toEqual([]);
});

it("initializes, reads account, paginates the native catalog, and never starts a turn", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-codex-probe-");
  const script = `${root}/probe.mjs`;
  await Fs.writeFile(
    script,
    `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      if (message.method === 'initialized') continue;
      let result;
      if (message.method === 'initialize') result = {};
      else if (message.method === 'account/read') result = { account: { type: 'chatgpt', email: 'test@example.com', planType: 'prolite' } };
      else if (message.method === 'model/list') result = {
        data: [{ model: message.params.cursor ? 'second' : 'first', displayName: 'Model', supportedReasoningEfforts: [], defaultReasoningEffort: 'medium' }],
        nextCursor: message.params.cursor ? null : 'next'
      };
      else process.exit(12);
      process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    }
  `,
  );

  try {
    const result = await discoverCodex({
      command: process.execPath,
      args: [script],
      cwd: root,
      signal: AbortSignal.timeout(2000),
    });
    expect(result.auth).toBe("authenticated");
    expect(result.account).toEqual({
      email: "test@example.com",
      label: "ChatGPT Pro 100 Subscription",
    });
    expect(result.models.map((model) => model.id)).toEqual(["first", "second"]);
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});
