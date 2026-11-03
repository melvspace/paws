import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type { ProviderSnapshot, TeamworkRequest } from "@paws/contracts";
import { ChatExecutionError, type RunChatTurn } from "@paws/provider-core";
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
  const main = makeChatService(root, () => [provider], run);
  service = makeTeamworkService(
    root,
    () => [provider],
    run,
    main,
    () => {},
  );
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
    handle(run: RunChatTurn) {
      handle = run;
    },
    async reopen() {
      await service.close();
      service = makeTeamworkService(
        root,
        () => [provider],
        run,
        main,
        () => {},
      );
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
      !turn.text.includes("[Paws agent message from")
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
