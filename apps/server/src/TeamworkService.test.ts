import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  symlink,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type { ProviderSnapshot, TeamworkRequest } from "@paws/contracts";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";
import { resolveWorkspaceDirectory } from "@paws/runtime";
import { agentExecutionPaths } from "./teamContext.ts";
import { relative } from "node:path";
import { makeAgentService } from "./AgentService.ts";
import { makeChatService } from "./ChatService.ts";
import { makeTeamworkService } from "./TeamworkService.ts";
import { serializeAgentExecution } from "./agentExecution.ts";

const provider: ProviderSnapshot = {
  config: {
    id: "test",
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
const selection = { providerId: "test", modelId: "model", options: {} };

async function setup() {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-peer-");
  const agents = makeAgentService(root);
  const team = await Effect.runPromise(
    agents.saveTeam({ name: "Builders", memory: "" }),
  );
  const otherTeam = await Effect.runPromise(
    agents.saveTeam({ name: "Other", memory: "" }),
  );
  const create = (name: string, teamId?: string) =>
    Effect.runPromise(agents.create({ name, ...(teamId ? { teamId } : {}) }));
  const requester = await create("Requester");
  const worker = await create("Worker");
  const reviewer = await create("Reviewer", team!.id);
  const other = await create("Other", otherTeam!.id);
  let handle: RunChatTurn = async () => {};
  let providersAvailable = true;
  const providers = () => (providersAvailable ? [provider] : []);
  let service: ReturnType<typeof makeTeamworkService>;
  const run = serializeAgentExecution(async (turn) => {
    service?.validateExecution(
      turn.requestId ?? turn.conversationId,
      turn.agentId,
    );
    await handle({
      ...turn,
      teamworkTool: (input) =>
        service.tool(turn.agentId, input, turn.conversationId, turn.requestId),
    });
  });
  const main = makeChatService(root, providers, run);
  service = makeTeamworkService(root, providers, run, main, () => {});
  await service.ready;
  const command = async (actor: string, input: TeamworkRequest) => {
    const result = await Effect.runPromise(
      Effect.result(service.execute(actor, input)),
    );

    if (result._tag === "Failure") throw result.failure;

    return result.success;
  };

  return {
    root,
    agents,
    requester,
    worker,
    reviewer,
    other,
    main,
    command,
    get service() {
      return service;
    },
    providersAvailable(value: boolean) {
      providersAvailable = value;
    },
    handle(run: RunChatTurn) {
      handle = run;
    },
    async reopen() {
      await service.close();
      service = makeTeamworkService(root, providers, run, main, () => {});
      await service.ready;
    },
    async [Symbol.asyncDispose]() {
      await service.close();
      await main.close();
      agents.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("discovers every agent and delivers requests and replies without teams or prior recipient chats", async () => {
  await using fixture = await setup();
  const { requester, worker, reviewer, other } = fixture;
  const roster = await fixture.service.tool(requester.id, { action: "list" });
  expect(
    "members" in roster && roster.members.map((member) => member.id),
  ).toEqual([requester.id, worker.id, reviewer.id, other.id]);
  const calls: string[] = [];
  fixture.handle(async (turn) => {
    calls.push(turn.agentId);
    expect(turn.text).toContain(
      turn.agentId === worker.id
        ? "not a new user request"
        : "not a message or new authorization",
    );
    turn.onText(
      "result",
      turn.agentId === worker.id
        ? "The endpoint passes its cleanup tests."
        : "Here is the verified result.",
      true,
    );
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Check the endpoint and return evidence.",
  });
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.filter((event) => event.delivery === "delivered").length,
    )
    .toBe(2);
  expect(calls).toEqual([worker.id, requester.id]);
  expect(
    fixture.main
      .get(requester.id)
      .messages.some(
        (message) =>
          message.peer?.fromAgentId === worker.id &&
          message.text.includes("cleanup tests"),
      ),
  ).toBe(true);
  expect(
    fixture.main
      .get(worker.id)
      .messages.some((message) => message.peer?.fromAgentId === requester.id),
  ).toBe(true);
});

it("communicates across teams without sharing either agent’s memory or environment context", async () => {
  await using fixture = await setup();
  const { reviewer, other } = fixture;
  const db = new DatabaseSync(join(fixture.root, "state.sqlite"));
  db.prepare(
    "UPDATE agents SET data = json_set(data, '$.memory', ?) WHERE id = ?",
  ).run("SENDER_PRIVATE_MEMORY", reviewer.id);
  db.close();
  let received = "";
  fixture.handle(async (turn) => {
    received = turn.text;
    expect(turn.agentId).toBe(other.id);
    turn.onText("result", "Updated", true);
  });
  await fixture.command(reviewer.id, {
    action: "message",
    toAgentId: other.id,
    text: "Inspect your API",
    expectsReply: false,
  });
  await expect
    .poll(() => fixture.service.list(reviewer.id).events[0]?.delivery)
    .toBe("delivered");
  expect(received).not.toContain("SENDER_PRIVATE_MEMORY");
  expect(received).toContain("information only");
  expect(fixture.service.list(reviewer.id).events).toHaveLength(1);
});

it("returns a delegated result to the requesting main conversation and keeps task management internal", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  const received: string[] = [];
  fixture.handle(async (turn) => {
    received.push(turn.agentId);

    if (
      turn.agentId === requester.id &&
      !turn.text.includes("[Paws agent message from")
    ) {
      await turn.teamworkTool!({
        action: "delegate",
        toAgentId: worker.id,
        title: "Investigate",
        text: "Find the fault and verify it.",
      });

      return;
    }

    turn.onText(
      "result",
      turn.agentId === worker.id
        ? "Found and verified a missing cleanup path."
        : "I checked the delegated result: cleanup is fixed.",
      true,
    );
  });
  await Effect.runPromise(
    fixture.main.send(requester.id, {
      requestId: "user-request",
      text: "Ask Worker to investigate",
      selection,
    }),
  );
  await expect
    .poll(() => fixture.main.get(requester.id).messages.at(-1)?.text)
    .toContain("cleanup is fixed");
  expect(received).toEqual([requester.id, worker.id, requester.id]);
  expect(fixture.service.list(requester.id).tasks[0]).toMatchObject({
    status: "done",
    ownerId: worker.id,
  });
  const before = fixture.service.list(requester.id);
  await expect.poll(() => fixture.service.busy(requester.id)).toBe(false);
  await fixture.reopen();
  expect(fixture.service.list(requester.id)).toEqual(before);
});

it("routes independent review across agents and returns approval to the requester", async () => {
  await using fixture = await setup();
  const { requester, worker, reviewer } = fixture;
  const calls: string[] = [];
  fixture.handle(async (turn) => {
    calls.push(turn.agentId);

    if (turn.agentId === reviewer.id) {
      const task = fixture.service.list(reviewer.id).tasks[0]!;
      expect(task.status).toBe("review");
      await turn.teamworkTool!({
        action: "review",
        taskId: task.id,
        revision: task.revision,
        verdict: "approve",
        text: "Inspected the result and cleanup tests.",
      });
    }

    turn.onText("result", "Evidence is ready.", true);
  });
  await fixture.command(requester.id, {
    action: "delegate",
    toAgentId: worker.id,
    reviewerId: reviewer.id,
    title: "Fix",
    text: "Fix and verify cleanup.",
  });
  await expect
    .poll(() => fixture.service.list(requester.id).tasks[0]?.status)
    .toBe("done");
  await expect
    .poll(() =>
      fixture.service
        .list(requester.id)
        .events.some(
          (event) => event.kind === "reply" && event.delivery === "delivered",
        ),
    )
    .toBe(true);
  expect(calls).toEqual([worker.id, reviewer.id, requester.id]);
  expect(
    fixture.main
      .get(requester.id)
      .messages.some(
        (message) => message.text === "Inspected the result and cleanup tests.",
      ),
  ).toBe(true);
});

it("enforces identity, task authority, revisions, and valid reply relationships", async () => {
  await using fixture = await setup();
  const { requester, worker, reviewer, other } = fixture;
  await expect(
    fixture.service.tool(requester.id, { action: "list", actor: other.id }),
  ).rejects.toThrow("fields");
  await expect(
    fixture.command(requester.id, {
      action: "message",
      toAgentId: "missing",
      text: "Hello",
    }),
  ).rejects.toThrow("not found");
  await expect(
    fixture.command(requester.id, {
      action: "delegate",
      title: "Bad",
      text: "Work",
      toAgentId: worker.id,
      reviewerId: worker.id,
    }),
  ).rejects.toThrow("different");
  const state = await fixture.command(requester.id, {
    action: "delegate",
    toAgentId: worker.id,
    reviewerId: reviewer.id,
    title: "Work",
    text: "Complete the checks.",
  });
  const task = state.tasks[0]!;
  await expect(
    fixture.command(other.id, {
      action: "submit",
      taskId: task.id,
      revision: 1,
      text: "Forged",
    }),
  ).rejects.toThrow("assigned");
  await fixture.command(worker.id, {
    action: "submit",
    taskId: task.id,
    revision: 1,
    text: "Result",
  });
  await expect(
    fixture.command(worker.id, {
      action: "cancel",
      taskId: task.id,
      revision: 1,
      text: "Stale",
    }),
  ).rejects.toThrow("changed");
  await expect(
    fixture.command(worker.id, {
      action: "review",
      taskId: task.id,
      revision: 2,
      text: "Self approval",
      verdict: "approve",
    }),
  ).rejects.toThrow("assigned");
  await expect(
    fixture.command(other.id, {
      action: "message",
      toAgentId: requester.id,
      replyToMessageId: state.events[0]!.id,
      text: "Forged reply",
    }),
  ).rejects.toThrow("Reply only");
});

it("hands work to another agent with context and returns requested changes to its owner", async () => {
  await using fixture = await setup();
  const { requester, worker, reviewer, other } = fixture;
  const state = await fixture.command(requester.id, {
    action: "delegate",
    toAgentId: worker.id,
    reviewerId: reviewer.id,
    title: "Work",
    text: "Check the draft",
  });
  const task = state.tasks[0]!;
  await fixture.command(worker.id, {
    action: "handoff",
    taskId: task.id,
    revision: 1,
    toAgentId: other.id,
    text: "Draft attached in the brief; tests remain.",
  });
  await fixture.command(other.id, {
    action: "submit",
    taskId: task.id,
    revision: 2,
    text: "Tests complete.",
  });
  await fixture.command(reviewer.id, {
    action: "review",
    taskId: task.id,
    revision: 3,
    verdict: "request_changes",
    text: "Cover cleanup failure.",
  });
  const latest = fixture.service.list(requester.id);
  expect(latest.tasks[0]).toMatchObject({
    ownerId: other.id,
    status: "assigned",
    revision: 4,
  });
  expect(fixture.service.list(other.id).events.at(-1)).toMatchObject({
    toAgentId: other.id,
    text: "Cover cleanup failure.",
  });
  expect(
    fixture.main
      .get(worker.id)
      .messages.some(
        (message) =>
          message.peer?.kind === "handoff" &&
          message.text.includes("tests remain"),
      ),
  ).toBe(true);
});

it("records failures and allows one explicit retry per attempt", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async () => {
    throw new ChatExecutionError("Runtime unavailable.");
  });
  const state = await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Inspect",
    expectsReply: false,
  });
  const event = state.events[0]!;
  await expect
    .poll(() => fixture.service.list(requester.id).events[0]?.delivery)
    .toBe("failed");
  fixture.handle(async () => {});
  await fixture.command(requester.id, { action: "retry", eventId: event.id });
  await expect(
    fixture.command(requester.id, { action: "retry", eventId: event.id }),
  ).rejects.toThrow("already has a retry");
  await expect
    .poll(() => fixture.service.list(requester.id).events.at(-1)?.delivery)
    .toBe("delivered");
});

it("does not replay interrupted actions and resumes only queued work after restart", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.signal.throwIfAborted();
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Inspect",
    expectsReply: false,
  });
  await expect
    .poll(() => fixture.service.list(requester.id).events[0]?.delivery)
    .toBe("running");
  await fixture.service.close();
  const db = new DatabaseSync(join(fixture.root, "state.sqlite"));
  db.exec(
    "UPDATE team_events SET data = json_set(data, '$.delivery', 'running')",
  );
  const row = db.prepare("SELECT data FROM team_events").get()!;
  const queued = {
    ...JSON.parse(String(row.data)),
    id: "queued-restart",
    delivery: "queued",
  };
  db.prepare("INSERT INTO team_events VALUES (?, ?)").run(
    queued.id,
    JSON.stringify(queued),
  );
  db.close();
  const calls: string[] = [];
  fixture.handle(async (turn) => {
    calls.push(turn.requestId!);
  });
  await fixture.reopen();
  await expect
    .poll(() => fixture.service.list(requester.id).events.at(-1)?.delivery)
    .toBe("delivered");
  expect(fixture.service.list(requester.id).events[0]?.delivery).toBe(
    "interrupted",
  );
  expect(calls).toEqual(["queued-restart"]);
});

it("bounds peer chains without relying on shared team membership", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    await turn.teamworkTool!({
      action: "message",
      toAgentId: turn.agentId === requester.id ? worker.id : requester.id,
      text: "Follow-up",
      expectsReply: false,
    });
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Start",
    expectsReply: false,
  });
  await expect
    .poll(() =>
      fixture.service
        .list(requester.id)
        .events.some((event) => event.delivery === "failed"),
    )
    .toBe(true);
  expect(fixture.service.list(requester.id).events).toHaveLength(9);
});

it("waits for nested delegation and resumes the owning agent before completing its internal work", async () => {
  await using fixture = await setup();
  const { requester, worker, other } = fixture;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  fixture.handle(async (turn) => {
    calls.push(turn.agentId);

    if (
      turn.agentId === worker.id &&
      turn.text.includes("[Paws peer message")
    ) {
      await turn.teamworkTool!({
        action: "message",
        toAgentId: other.id,
        text: "Check the API before I finish the root task.",
      });
      turn.onText("progress", "Waiting for the API check.", true);

      return;
    }

    if (turn.agentId === other.id) await held;

    turn.onText(
      "result",
      turn.agentId === other.id
        ? "The API check passed."
        : "Combined result verified.",
      true,
    );
  });
  try {
    await fixture.command(requester.id, {
      action: "delegate",
      toAgentId: worker.id,
      title: "Root",
      text: "Produce a verified result.",
    });
    await expect.poll(() => fixture.service.busy(other.id)).toBe(true);
    expect(fixture.service.list(requester.id).tasks[0]?.status).toBe(
      "assigned",
    );
    release();
    await expect
      .poll(() => fixture.service.list(requester.id).tasks[0]?.status)
      .toBe("done");
    await expect
      .poll(() =>
        fixture.main
          .get(requester.id)
          .messages.some((message) => message.peer?.kind === "reply"),
      )
      .toBe(true);
    expect(calls).toEqual([worker.id, other.id, worker.id, requester.id]);
  } finally {
    release();
  }
});

it("correlates explicit replies and suppresses the automatic duplicate", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    if (turn.agentId !== worker.id) return;

    await turn.teamworkTool!({
      action: "message",
      toAgentId: requester.id,
      replyToMessageId: turn.requestId,
      expectsReply: false,
      text: "Here is the requested evidence.",
    });
    turn.onText("result", "Reply sent.", true);
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Return evidence.",
  });
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.filter((event) => event.delivery === "delivered").length,
    )
    .toBe(2);
  expect(
    fixture.service
      .list(requester.id)
      .events.filter((event) => event.kind === "reply"),
  ).toHaveLength(1);
});

it("returns a delivery failure to the requester rather than leaving it waiting indefinitely", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    if (turn.agentId === worker.id)
      throw new ChatExecutionError("Runtime unavailable.");

    expect(turn.text).toContain("could not complete");
    turn.onText(
      "result",
      "The worker is unavailable; I need your guidance.",
      true,
    );
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Check the API.",
  });
  await expect
    .poll(() => fixture.main.get(requester.id).messages.at(-1)?.text)
    .toContain("need your guidance");
  expect(
    fixture.service.list(requester.id).events.map((event) => event.delivery),
  ).toEqual(["failed", "delivered"]);
});

it("cancels internal assignments when the user deletes an agent instead of requiring task management", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    if (turn.agentId !== worker.id) return;

    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.signal.throwIfAborted();
  });
  await fixture.command(requester.id, {
    action: "delegate",
    toAgentId: worker.id,
    title: "Work",
    text: "Investigate",
  });
  await expect.poll(() => fixture.service.busy(worker.id)).toBe(true);
  await Effect.runPromise(
    fixture.agents.remove(worker.id, () =>
      fixture.service.removeAgent(worker.id),
    ),
  );
  expect(fixture.service.list(requester.id).tasks[0]?.status).toBe("cancelled");
  await expect.poll(() => fixture.service.busy(worker.id)).toBe(false);
});

it("shuts down a reply turn running in the original chat without waiting for that chat to close first", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  let resumed = false;
  fixture.handle(async (turn) => {
    if (turn.agentId === worker.id) {
      turn.onText("result", "Result ready", true);

      return;
    }

    resumed = true;
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.signal.throwIfAborted();
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Investigate",
  });
  await expect.poll(() => resumed).toBe(true);
  await fixture.service.close();
  expect(fixture.main.busy(requester.id)).toBe(false);
});

it("publishes pending reply batches with settled siblings and preserves request context for expanded updates", async () => {
  await using fixture = await setup();
  const { requester, worker, other } = fixture;
  let releaseWorker = () => {};
  let releaseOther = () => {};
  const workerHeld = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const otherHeld = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  fixture.handle(async (turn) => {
    if (turn.agentId === requester.id) return;

    await (turn.agentId === worker.id ? workerHeld : otherHeld);
    turn.onText("result", "Verified the requested result.", true);
  });

  try {
    await fixture.service.tool(
      requester.id,
      { action: "message", toAgentId: worker.id, text: "Check the API." },
      requester.id,
      "same-turn",
    );
    await fixture.service.tool(
      requester.id,
      { action: "message", toAgentId: other.id, text: "Check cleanup." },
      requester.id,
      "same-turn",
    );
    await expect
      .poll(() => fixture.service.replyWaits().map((wait) => wait.status))
      .toEqual(["working", "working"]);
    releaseWorker();
    await expect
      .poll(() => fixture.service.replyWaits().map((wait) => wait.status))
      .toEqual(["done", "working"]);
    expect(
      fixture.service
        .replyWaits()
        .every((wait) => wait.batchId === "same-turn"),
    ).toBe(true);
    const reply = fixture.main
      .get(requester.id)
      .messages.find((message) => message.peer?.kind === "reply");
    expect(reply?.peer).toMatchObject({
      requestText: "Check the API.",
      requestAuthor: "Requester",
      expectsReply: false,
    });
    releaseOther();
    await expect.poll(() => fixture.service.replyWaits()).toEqual([]);
  } finally {
    releaseWorker();
    releaseOther();
  }
});

it("settles a received reply even when continuing the requester’s conversation fails afterward", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    turn.onText(
      "result",
      turn.agentId === worker.id
        ? "They do not have the guts."
        : "Joker says: They do not have the guts.",
      true,
    );

    if (turn.agentId === requester.id)
      throw new ChatExecutionError("Could not restore conversation context.");
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Ask Joker for a joke.",
  });
  await expect
    .poll(() =>
      fixture.main
        .get(requester.id)
        .messages.some(
          (message) =>
            message.peer?.kind === "reply" && message.delivery === "delivered",
        ),
    )
    .toBe(true);
  await expect.poll(() => fixture.service.busy(requester.id)).toBe(false);
  expect(
    fixture.main
      .get(requester.id)
      .messages.some(
        (message) => message.text === "Joker says: They do not have the guts.",
      ),
  ).toBe(true);
  expect(fixture.service.replyWaits()).toEqual([]);
});

it("reconciles a persisted failed delivery when its reply is already in the receiving chat", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    turn.onText("result", "The requested joke.", true);
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Ask for a joke.",
  });
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.find((event) => event.kind === "reply")?.delivery,
    )
    .toBe("delivered");
  await expect.poll(() => fixture.service.busy(requester.id)).toBe(false);
  const reply = fixture.service
    .list(requester.id)
    .events.find((event) => event.kind === "reply")!;
  const trace = fixture.main
    .get(worker.id)
    .messages.find((message) => message.peer?.eventId === reply.id)?.peer;
  expect(trace).toBeDefined();
  fixture.main.append(worker.id, "Continuation failed", undefined, {
    ...trace!,
    delivery: "failed",
  });
  await fixture.service.close();
  const db = new DatabaseSync(join(fixture.root, "state.sqlite"));
  db.prepare(
    "UPDATE team_events SET data = json_set(data, '$.delivery', 'failed', '$.error', 'Continuation failed') WHERE id = ?",
  ).run(reply.id);
  db.close();
  await fixture.reopen();
  expect(
    fixture.service
      .list(requester.id)
      .events.find((event) => event.id === reply.id),
  ).toMatchObject({ delivery: "delivered" });
  expect(
    fixture.service
      .list(requester.id)
      .events.find((event) => event.id === reply.id)?.error,
  ).toBeUndefined();
  expect(fixture.service.replyWaits()).toEqual([]);
  expect(
    fixture.main
      .get(worker.id)
      .messages.find((message) => message.peer?.eventId === reply.id)?.peer
      ?.delivery,
  ).toBe("delivered");
});

it("stops waiting as soon as the reply is received while the requester continues processing it", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumed = false;
  fixture.handle(async (turn) => {
    if (turn.agentId === worker.id) {
      turn.onText("result", "Here is the joke.", true);

      return;
    }

    resumed = true;
    await held;
  });

  try {
    await fixture.command(requester.id, {
      action: "message",
      toAgentId: worker.id,
      text: "Get a joke.",
    });
    await expect.poll(() => resumed).toBe(true);
    expect(fixture.service.busy(requester.id)).toBe(true);
    expect(fixture.service.replyWaits()).toEqual([]);
  } finally {
    release();
  }
});

it("copies file and image snapshots across workspaces and automatically returns result files", async () => {
  await using fixture = await setup();
  const { requester, other } = fixture;
  const senderWorkspace = resolveWorkspaceDirectory(
    fixture.root,
    requester.id,
    "workspace",
  );
  const targetWorkspace = resolveWorkspaceDirectory(
    fixture.root,
    other.id,
    "workspace",
  );
  await writeFile(join(senderWorkspace, "brief.txt"), "Original brief");
  await writeFile(
    join(senderWorkspace, "picture.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const received: string[] = [];
  fixture.handle(async (turn) => {
    const conversation =
      turn.agentId === other.id
        ? fixture.service.conversations.get(turn.conversationId!)
        : fixture.main.get(requester.id);
    const input = conversation.messages.find(
      (message) => message.id === turn.requestId,
    )!;
    expect(input.peer).toBeDefined();
    expect(turn.text).toContain("untrusted peer data");

    for (const file of input.attachments ?? []) {
      const resolved = await turn.readAttachment!(file.id);
      const local = join(
        resolveWorkspaceDirectory(fixture.root, turn.agentId, "workspace"),
        relative(
          agentExecutionPaths(fixture.root, turn.agentId).workspace,
          resolved.path,
        ),
      );
      received.push(`${turn.agentName}:${await readFile(local, "utf8")}`);
      if (turn.agentId === other.id)
        expect(resolved.path).not.toContain(senderWorkspace);
    }

    if (turn.agentId === other.id) {
      await writeFile(join(targetWorkspace, "result.txt"), "Verified result");
      await turn.onMessage(
        "result-file",
        { text: "The result is attached.", actions: [], fields: [] },
        [
          {
            path: `${agentExecutionPaths(fixture.root, other.id).workspace}/result.txt`,
          },
        ],
      );
    }
  });
  const state = await fixture.command(requester.id, {
    action: "message",
    toAgentId: other.id,
    text: "Review the attached brief and image.",
    attachments: [{ path: "brief.txt" }, { path: "picture.png" }],
  });
  await writeFile(join(senderWorkspace, "brief.txt"), "Changed after sending");
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.find((event) => event.kind === "reply")?.delivery,
    )
    .toBe("delivered");
  expect(received).toContain("Other:Original brief");
  expect(received).toContain("Requester:Verified result");
  const request = state.events[0]!;
  expect(request.attachments?.map((file) => file.mediaType)).toEqual([
    "application/octet-stream",
    "image/png",
  ]);
  const senderTrace = fixture.main
    .get(requester.id)
    .messages.find((message) => message.peer?.eventId === request.id)!;
  expect(senderTrace.attachments).toHaveLength(2);
  const downloaded = await fixture.main.attachment(
    requester.id,
    senderTrace.attachments![0]!.id,
  );
  expect(downloaded.data.toString()).toBe("Original brief");
});

it("rejects file escapes and invalid broadcasts without enqueueing partial requests", async () => {
  await using fixture = await setup();
  const { requester, worker, other } = fixture;
  const workspace = resolveWorkspaceDirectory(
    fixture.root,
    requester.id,
    "workspace",
  );
  await writeFile(join(fixture.root, "private.txt"), "Private fixture data");
  await symlink(
    join(fixture.root, "private.txt"),
    join(workspace, "escape.txt"),
  );

  for (const attachments of [
    [{ path: "../private.txt" }],
    [{ path: "escape.txt" }],
  ]) {
    await expect(
      fixture.command(requester.id, {
        action: "message",
        toAgentIds: [worker.id, other.id],
        text: "Inspect",
        attachments,
      }),
    ).rejects.toThrow();
  }

  for (const toAgentIds of [
    [],
    [worker.id, worker.id],
    [worker.id, requester.id],
    [worker.id, "missing"],
    Array.from({ length: 33 }, (_, index) => `agent-${index}`),
  ]) {
    await expect(
      fixture.command(requester.id, {
        action: "message",
        toAgentIds,
        text: "Inspect",
      }),
    ).rejects.toThrow();
  }

  expect(fixture.service.list(requester.id).events).toEqual([]);
});

it("sends one operation to multiple recipients and tracks independent replies", async () => {
  await using fixture = await setup();
  const { requester, worker, other } = fixture;
  const calls: string[] = [];
  fixture.handle(async (turn) => {
    calls.push(turn.agentId);

    if (turn.agentId !== requester.id)
      turn.onText("result", `${turn.agentName} checked`, true);
  });
  await fixture.service.tool(
    requester.id,
    {
      action: "message",
      toAgentIds: [worker.id, other.id],
      text: "Check your part.",
    },
    requester.id,
    "broadcast-turn",
  );
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.filter(
            (event) => event.kind === "reply" && event.delivery === "delivered",
          ).length,
    )
    .toBe(2);
  const requests = fixture.service
    .list(requester.id)
    .events.filter((event) => event.kind === "message");
  expect(new Set(requests.map((event) => event.id)).size).toBe(2);
  expect(requests.map((event) => event.originRequestId)).toEqual([
    "broadcast-turn",
    "broadcast-turn",
  ]);
  expect(calls.filter((id) => id === worker.id)).toHaveLength(1);
  expect(calls.filter((id) => id === other.id)).toHaveLength(1);
  expect(fixture.service.replyWaits()).toEqual([]);
});

it("interrupts only the requester's peer work while user work and another sender continue", async () => {
  await using fixture = await setup();
  const { requester, worker, reviewer } = fixture;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let userStarted = false;
  let userAborted = false;
  const completed: string[] = [];
  fixture.handle(async (turn) => {
    if (turn.requestId === "user-work") {
      userStarted = true;
      turn.signal.addEventListener(
        "abort",
        () => {
          userAborted = true;
        },
        { once: true },
      );
      await held;
    } else {
      completed.push(turn.text);
    }

    turn.onText("result", "Completed", true);
  });

  try {
    await Effect.runPromise(
      fixture.main.send(worker.id, {
        requestId: "user-work",
        selection,
        text: "User-owned work",
      }),
    );
    await expect.poll(() => userStarted).toBe(true);
    await fixture.command(requester.id, {
      action: "message",
      toAgentId: worker.id,
      text: "First cancelled request",
    });
    await fixture.command(requester.id, {
      action: "message",
      toAgentId: worker.id,
      text: "Second cancelled request",
    });
    await fixture.command(reviewer.id, {
      action: "message",
      toAgentId: worker.id,
      text: "Other sender work",
      expectsReply: false,
    });
    await fixture.command(requester.id, {
      action: "interrupt",
      toAgentId: worker.id,
    });
    expect(userAborted).toBe(false);
    expect(fixture.main.busy(worker.id)).toBe(true);
    expect(
      fixture.service.list(requester.id).events.map((event) => event.delivery),
    ).toEqual(["cancelled", "cancelled"]);
    expect(
      fixture.service
        .replyWaits()
        .filter((wait) => wait.agentId === requester.id),
    ).toEqual([]);
    release();
    await expect
      .poll(() => fixture.service.list(reviewer.id).events[0]?.delivery)
      .toBe("delivered");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toContain("Other sender work");
  } finally {
    release();
  }
});

it("aborts active and nested peer execution and rejects interruption of someone else's request", async () => {
  await using fixture = await setup();
  const { requester, worker, other, reviewer } = fixture;
  let nestedStarted = false;
  let aborted = false;
  fixture.handle(async (turn) => {
    if (turn.agentId === worker.id) {
      await turn.teamworkTool!({
        action: "message",
        toAgentId: other.id,
        text: "Nested work",
      });

      return;
    }

    nestedStarted = true;
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      );
    });
    turn.signal.throwIfAborted();
  });
  const state = await fixture.command(requester.id, {
    action: "delegate",
    toAgentId: worker.id,
    title: "Root",
    text: "Delegate the check",
  });
  const event = state.events[0]!;
  await expect.poll(() => nestedStarted).toBe(true);
  await expect(
    fixture.command(reviewer.id, {
      action: "interrupt",
      toAgentId: worker.id,
      eventId: event.id,
    }),
  ).rejects.toThrow("own requests");
  await fixture.command(requester.id, {
    action: "interrupt",
    toAgentId: worker.id,
    eventId: event.id,
  });
  expect(aborted).toBe(true);
  expect(fixture.service.list(requester.id).tasks[0]?.status).toBe("cancelled");
  expect(
    fixture.service
      .list(worker.id)
      .events.every((item) => item.delivery === "cancelled"),
  ).toBe(true);
  expect(fixture.service.replyWaits()).toEqual([]);
});

it("discovers specialties, availability, queue counts and waits without exposing private context", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  await Effect.runPromise(
    fixture.agents.update(worker.id, {
      name: worker.name,
      role: "API reviewer",
      description: "Checks endpoint behavior",
      memory: "PRIVATE_MEMORY",
    }),
  );
  fixture.handle(async (turn) => {
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.signal.throwIfAborted();
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Check endpoints",
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Also check cleanup",
    expectsReply: false,
  });
  const roster = fixture.service.roster();
  expect(roster.find((agent) => agent.id === worker.id)).toMatchObject({
    role: "API reviewer",
    description: "Checks endpoint behavior",
    availability: "working",
    queuedMessages: 1,
  });
  expect(roster.find((agent) => agent.id === requester.id)).toMatchObject({
    availability: "waiting",
    openWaits: [{ toAgentId: worker.id }],
  });
  expect(JSON.stringify(roster)).not.toContain("PRIVATE_MEMORY");
  await fixture.command(requester.id, {
    action: "interrupt",
    toAgentId: worker.id,
  });
});

it("retries a persisted file snapshot after the sender's original is removed", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  const source = join(
    resolveWorkspaceDirectory(fixture.root, requester.id, "workspace"),
    "brief.txt",
  );
  await writeFile(source, "Durable snapshot");
  fixture.handle(async () => {
    throw new ChatExecutionError("Temporary model failure");
  });
  const state = await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Inspect the file",
    expectsReply: false,
    attachments: [{ path: "brief.txt" }],
  });
  await expect
    .poll(() => fixture.service.list(requester.id).events[0]?.delivery)
    .toBe("failed");
  await rm(source);
  await fixture.reopen();
  let contents = "";
  fixture.handle(async (turn) => {
    const message = fixture.service.conversations
      .get(turn.conversationId!)
      .messages.find((item) => item.id === turn.requestId)!;
    const file = await turn.readAttachment!(message.attachments![0]!.id);
    contents = await readFile(
      join(
        resolveWorkspaceDirectory(fixture.root, worker.id, "workspace"),
        relative(
          agentExecutionPaths(fixture.root, worker.id).workspace,
          file.path,
        ),
      ),
      "utf8",
    );
  });
  await fixture.command(requester.id, {
    action: "retry",
    eventId: state.events[0]!.id,
  });
  await expect
    .poll(() => fixture.service.list(requester.id).events.at(-1)?.delivery)
    .toBe("delivered");
  expect(contents).toBe("Durable snapshot");
});

it("preserves submitted artifacts through independent review and returns them to the requester", async () => {
  await using fixture = await setup();
  const { requester, worker, reviewer } = fixture;
  let artifactId = "";
  fixture.handle(async (turn) => {
    if (turn.agentId === worker.id) {
      await writeFile(
        join(
          resolveWorkspaceDirectory(fixture.root, worker.id, "workspace"),
          "result.txt",
        ),
        "Reviewed artifact",
      );
      await turn.onMessage(
        "result",
        { text: "Implementation ready", actions: [], fields: [] },
        [{ path: "result.txt" }],
      );
    } else if (turn.agentId === reviewer.id) {
      const input = fixture.service.conversations
        .get(turn.conversationId!)
        .messages.find((message) => message.id === turn.requestId)!;
      artifactId = input.attachments![0]!.id;
      expect(await turn.readAttachment!(artifactId)).toMatchObject({
        name: "result.txt",
      });
      const task = fixture.service.list(reviewer.id).tasks[0]!;
      await turn.teamworkTool!({
        action: "review",
        taskId: task.id,
        revision: task.revision,
        verdict: "approve",
        text: "Artifact checked",
      });
    }
  });
  await fixture.command(requester.id, {
    action: "delegate",
    toAgentId: worker.id,
    reviewerId: reviewer.id,
    title: "Produce an artifact",
    text: "Implement and review the file",
  });
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.find((event) => event.kind === "reply")?.delivery,
    )
    .toBe("delivered");
  expect(
    (await fixture.main.attachment(requester.id, artifactId)).data.toString(),
  ).toBe("Reviewed artifact");
});

it("revokes cancelled peer requests so late tools cannot enqueue more work", async () => {
  await using fixture = await setup();
  const { requester, worker, other } = fixture;
  let started = false;
  fixture.handle(async (turn) => {
    started = true;
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.signal.throwIfAborted();
  });
  const state = await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Inspect",
  });
  await expect.poll(() => started).toBe(true);
  const id = state.events[0]!.id;
  await fixture.command(requester.id, {
    action: "interrupt",
    toAgentId: worker.id,
    eventId: id,
  });
  await expect(
    fixture.service.tool(
      worker.id,
      { action: "message", toAgentId: other.id, text: "Late request" },
      id,
      id,
    ),
  ).rejects.toThrow("cancelled");
  await expect(
    fixture.command(worker.id, {
      action: "message",
      toAgentId: requester.id,
      replyToMessageId: id,
      expectsReply: false,
      text: "Late reply",
    }),
  ).rejects.toThrow("cancelled");
  expect(fixture.service.list(other.id).events).toEqual([]);
});

it("restores explanations and retry controls for old stopped requests without replaying them", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  fixture.handle(async (turn) => {
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    turn.signal.throwIfAborted();
  });
  const state = await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Identify the video",
  });
  await expect
    .poll(() => fixture.service.list(requester.id).events[0]?.delivery)
    .toBe("running");
  await fixture.reopen();
  expect(fixture.service.busy(worker.id)).toBe(false);
  const eventId = state.events[0]!.id;
  expect(fixture.service.replyWaits()[0]?.recovery).toMatchObject({
    eventId,
    kind: "request",
    canRetry: true,
    retried: false,
    reason:
      "Paws restarted before this request finished. No reply was received.",
  });
  const message = fixture.main
    .get(requester.id)
    .messages.find((item) => item.peer?.eventId === eventId)!;
  expect(message.text).toBe("Identify the video");
  expect(message.peer?.recovery?.canRetry).toBe(true);
  fixture.handle(async () => {});
  await fixture.command(requester.id, { action: "retry", eventId });
  const old = fixture.main
    .get(requester.id)
    .messages.find((item) => item.peer?.eventId === eventId)!;
  expect(old.peer?.recovery).toMatchObject({ canRetry: false, retried: true });
  expect(
    fixture.service.replyWaits().every((wait) => wait.requestId !== eventId),
  ).toBe(true);
});

it("retries a failed return delivery without asking the worker to repeat completed work", async () => {
  await using fixture = await setup();
  const { requester, worker } = fixture;
  let workerTurns = 0;
  fixture.handle(async (turn) => {
    if (turn.agentId === worker.id) {
      workerTurns++;
      fixture.providersAvailable(false);
      turn.onText("result", "Saved result", true);
    }
  });
  await fixture.command(requester.id, {
    action: "message",
    toAgentId: worker.id,
    text: "Identify this file",
  });
  await expect
    .poll(
      () =>
        fixture.service
          .list(requester.id)
          .events.find((event) => event.kind === "reply")?.delivery,
    )
    .toBe("failed");
  const failedReply = fixture.service
    .list(requester.id)
    .events.find((event) => event.kind === "reply")!;
  expect(fixture.service.replyWaits()[0]?.recovery).toMatchObject({
    eventId: failedReply.id,
    kind: "reply",
    canRetry: true,
  });
  fixture.providersAvailable(true);
  await fixture.command(requester.id, {
    action: "retry",
    eventId: failedReply.id,
  });
  await expect.poll(() => fixture.service.replyWaits()).toEqual([]);
  expect(workerTurns).toBe(1);
  expect(
    fixture.main
      .get(requester.id)
      .messages.some(
        (message) =>
          message.peer?.kind === "reply" && message.text === "Saved result",
      ),
  ).toBe(true);
});
