import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type { ProviderSnapshot } from "@paws/contracts";
import { makeAgentService } from "./AgentService.ts";
import { makeChatService } from "./ChatService.ts";
import { makeAgentManagementService } from "./AgentManagementService.ts";

const provider: ProviderSnapshot = {
  config: {
    id: "provider",
    driver: "codex",
    name: "Test",
    enabled: true,
    binaryPath: "",
    args: [],
  },
  status: "ready",
  auth: "authenticated",
  version: "1",
  message: null,
  checkedAt: null,
  models: [{ id: "model", name: "Model", options: [] }],
};
const selection = { providerId: "provider", modelId: "model", options: {} };

async function setup() {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-agent-management-");
  let idle = true;
  const agents = makeAgentService(root, () => idle);
  const actor = await Effect.runPromise(
    agents.create({ name: "Coordinator", memory: "PRIVATE_MEMORY" }),
  );
  let chat = makeChatService(
    root,
    () => [provider],
    async () => {},
  );
  const invalidated: string[] = [];
  const management = () =>
    makeAgentManagementService(
      agents,
      chat,
      () => idle,
      (id) => {
        invalidated.push(id);
      },
      () => {},
    );

  return {
    root,
    agents,
    actor,
    invalidated,
    tool: (value: unknown, allowed = true) =>
      management().tool(actor.id, value, allowed),
    idle(value: boolean) {
      idle = value;
    },
    get chat() {
      return chat;
    },
    async reopen() {
      await chat.close();
      chat = makeChatService(
        root,
        () => [provider],
        async () => {},
      );
    },
    async [Symbol.asyncDispose]() {
      await chat.close();
      agents.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("creates and configures persistent specialties and models without exposing private context", async () => {
  await using fixture = await setup();
  const created = await fixture.tool({
    action: "create",
    name: "Reviewer",
    role: "API reviewer",
    description: "Reviews endpoint behavior",
    selection,
  });
  expect(created).toMatchObject({
    agent: { name: "Reviewer", role: "API reviewer" },
    selection,
  });
  const id = created.agent.id;
  await fixture.tool({
    action: "update",
    agentId: id,
    role: "Release reviewer",
    description: "Checks release readiness",
  });
  await fixture.reopen();
  expect(
    await fixture.tool({ action: "read", agentId: id }, false),
  ).toMatchObject({
    agent: {
      role: "Release reviewer",
      description: "Checks release readiness",
    },
    selection,
  });
  expect(
    JSON.stringify(await fixture.tool({ action: "read" }, false)),
  ).not.toContain("PRIVATE_MEMORY");
  expect(await Effect.runPromise(fixture.agents.list())).toHaveLength(2);
});

it("denies peer and routine configuration and forged identities without side effects", async () => {
  await using fixture = await setup();

  for (const action of ["create", "update"]) {
    await expect(
      fixture.tool({ action, name: "Unauthorized" }, false),
    ).rejects.toThrow("direct user conversation");
  }

  await expect(
    fixture.tool({
      action: "create",
      agentId: fixture.actor.id,
      name: "Forged",
    }),
  ).rejects.toThrow("server-assigned");
  await expect(
    fixture.tool({ action: "update", agentId: "missing", name: "Missing" }),
  ).rejects.toThrow("not found");
  await expect(
    fixture.tool({ action: "update", memory: "Read someone else's memory" }),
  ).rejects.toThrow("fields");
  expect(await Effect.runPromise(fixture.agents.list())).toHaveLength(1);
});

it("validates configuration before provisioning and preserves prior settings after failure", async () => {
  await using fixture = await setup();

  for (const settings of [
    { name: " " },
    { name: "Worker", role: "x".repeat(161) },
    { name: "Worker", description: "x".repeat(2001) },
    { name: "Worker", selection: { ...selection, modelId: "missing" } },
    {
      name: "Worker",
      selection: { ...selection, options: { unsupported: "value" } },
    },
  ]) {
    await expect(
      fixture.tool({ action: "create", ...settings }),
    ).rejects.toThrow();
  }

  fixture.idle(false);
  await expect(
    fixture.tool({ action: "update", name: "Changed", sandbox: true }),
  ).rejects.toThrow("idle");
  await expect(fixture.tool({ action: "update", selection })).rejects.toThrow(
    "idle",
  );
  expect((await fixture.tool({ action: "read" })).agent.name).toBe(
    "Coordinator",
  );
  fixture.idle(true);
  await fixture.tool({ action: "update", sandbox: true });
  expect(fixture.invalidated).toEqual([fixture.actor.id]);
  expect(await Effect.runPromise(fixture.agents.list())).toHaveLength(1);
});
