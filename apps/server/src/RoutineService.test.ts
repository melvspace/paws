import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import type {
  ProviderSnapshot,
  SaveRoutine,
  ChatSelection,
} from "@paws/contracts";
import type { ChatTurn, RunChatTurn } from "@paws/provider-core";
import { makeAgentService } from "./AgentService.ts";
import { makeChatService } from "./ChatService.ts";
import { makeRoutineService } from "./RoutineService.ts";
import { serializeAgentExecution } from "./agentExecution.ts";
import { nextRoutineTime, validateTrigger } from "./routineSchedule.ts";

const selection: ChatSelection = {
  providerId: "codex",
  modelId: "model",
  options: {},
};
const provider: ProviderSnapshot = {
  config: {
    id: "codex",
    driver: "codex",
    name: "Codex",
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
const definition = (patch: Partial<SaveRoutine> = {}): SaveRoutine => ({
  name: "Digest",
  instruction: "Summarize the work",
  enabled: true,
  trigger: { kind: "interval", minutes: 60 },
  missed: "skip",
  timeoutMinutes: 60,
  ...patch,
});

async function setup(
  run: RunChatTurn = async (turn) => {
    turn.onText("reply", "Done", true);
  },
) {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-routines-");
  const agents = makeAgentService(root);
  const agent = await Effect.runPromise(agents.create({ name: "Ada" }));
  const other = await Effect.runPromise(agents.create({ name: "Grace" }));
  const runner = serializeAgentExecution(run);
  const main = makeChatService(root, () => [provider], runner);
  await Effect.runPromise(
    main.send(agent.id, { requestId: "setup", text: "Hello", selection }),
  );
  await expect.poll(() => main.busy(agent.id)).toBe(false);
  let service = makeRoutineService(
    root,
    () => [provider],
    runner,
    main,
    () => {},
  );
  await service.ready;

  return {
    root,
    agents,
    agent,
    other,
    main,
    get service() {
      return service;
    },
    async reopen() {
      await service.close();
      service = makeRoutineService(
        root,
        () => [provider],
        runner,
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

it("persists routines, prevents stale edits and cross-agent management, and keeps each run separate", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onText("reply", "Done", true);
  });
  const routine = fixture.service.save(fixture.agent.id, definition());
  expect(() =>
    fixture.service.save(fixture.agent.id, definition(), routine.id, "user", 0),
  ).toThrow("Routine changed");
  await expect(
    fixture.service.tool(fixture.other.id, {
      action: "delete",
      id: routine.id,
    }),
  ).rejects.toThrow("Routine not found");
  await fixture.reopen();
  expect(fixture.service.list(fixture.agent.id).routines).toHaveLength(1);
  const run = fixture.service.enqueue(routine.id, "manual");
  await fixture.service.tick();
  await expect
    .poll(() => fixture.service.getRun(run.id).status)
    .toBe("succeeded");
  expect(calls.at(-1)?.agentId).toBe(fixture.agent.id);
  expect(calls.at(-1)?.nativeThreadId).toBeNull();
  expect(calls.at(-1)?.text).toContain("Summarize the work");
  expect(fixture.main.get(fixture.agent.id).messages).toHaveLength(2);
  expect(fixture.service.conversations.get(run.id).messages).toHaveLength(2);
  expect(fixture.service.getRun(run.id).selection).toEqual(selection);
});

it("authenticates signed raw payloads, filters events, durably deduplicates deliveries, and revokes secrets", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({
      trigger: {
        kind: "webhook",
        eventType: "issue",
        filters: [{ path: "data.repo", operator: "equals", value: "paws" }],
      },
    }),
  );
  const { secret } = fixture.service.rotate(routine.id);
  const body = Buffer.from('{"type":"issue","data":{"repo":"paws"}}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "x-paws-timestamp": timestamp,
    "x-paws-signature": createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex"),
    "x-paws-delivery-id": "delivery-1",
  };
  expect(() =>
    fixture.service.webhook(
      routine.id,
      { ...headers, "x-paws-signature": "0".repeat(64) },
      body,
    ),
  ).toThrow("signature");
  expect(fixture.service.webhook(routine.id, headers, body)).toMatchObject({
    outcome: "accepted",
  });
  await fixture.reopen();
  expect(fixture.service.webhook(routine.id, headers, body)).toEqual({
    outcome: "duplicate",
  });
  const skipped = Buffer.from('{"type":"other"}');
  expect(
    fixture.service.webhook(
      routine.id,
      {
        ...headers,
        "x-paws-delivery-id": "delivery-2",
        "x-paws-signature": createHmac("sha256", secret)
          .update(`${timestamp}.`)
          .update(skipped)
          .digest("hex"),
      },
      skipped,
    ),
  ).toEqual({ outcome: "filtered" });
  fixture.service.rotate(routine.id);
  expect(() => fixture.service.webhook(routine.id, headers, body)).toThrow(
    "signature",
  );
  expect(JSON.stringify(fixture.service.list(fixture.agent.id))).not.toContain(
    secret,
  );
});

it("combines pending ticks, cancels queues on pause, and allows explicit manual execution while paused", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(fixture.agent.id, definition());
  const first = fixture.service.enqueue(routine.id, "schedule");
  expect(fixture.service.enqueue(routine.id, "schedule").id).toBe(first.id);
  fixture.service.save(
    fixture.agent.id,
    definition({ enabled: false }),
    routine.id,
    "user",
    routine.revision,
  );
  expect(fixture.service.getRun(first.id).status).toBe("cancelled");
  const manual = fixture.service.enqueue(routine.id, "manual");
  await fixture.service.tick();
  await expect
    .poll(() => fixture.service.getRun(manual.id).status)
    .toBe("succeeded");
  expect(fixture.service.list(fixture.agent.id).routines[0]?.enabled).toBe(
    false,
  );
});

it("supports waiting responses in the same run thread without blocking ordinary chat", async () => {
  await using fixture = await setup(async (turn) => {
    turn.onThread("native-thread");

    if (turn.text.includes("Paws routine"))
      await turn.onMessage("question", {
        text: "Approve?",
        actions: [{ id: "yes", label: "Approve" }],
        fields: [],
      });
    else turn.onText("reply", "Done", true);
  });
  const routine = fixture.service.save(fixture.agent.id, definition());
  const run = fixture.service.enqueue(routine.id, "manual");
  await fixture.service.tick();
  await expect
    .poll(() => fixture.service.getRun(run.id).status)
    .toBe("waiting");
  expect(fixture.main.busy(fixture.agent.id)).toBe(false);
  const message = fixture.service.conversations
    .get(run.id)
    .messages.find((item) => item.card);
  expect(message).toBeDefined();
  await fixture.service.respond(run.id, {
    requestId: "approval",
    selection,
    text: "",
    reply: { messageId: message!.id, actionId: "yes", values: {} },
  });
  await expect
    .poll(() => fixture.service.getRun(run.id).status)
    .toBe("succeeded");
});

it("marks interrupted executions after restart and never silently reruns them", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(fixture.agent.id, definition());
  const run = fixture.service.enqueue(routine.id, "manual");
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);
  db.prepare("UPDATE routine_runs SET data = ? WHERE id = ?").run(
    JSON.stringify({ ...run, status: "running" }),
    run.id,
  );
  db.close();
  await fixture.reopen();
  expect(fixture.service.getRun(run.id).status).toBe("interrupted");
  await fixture.service.tick();
  expect(fixture.service.getRun(run.id).status).toBe("interrupted");
});

it("deleting an agent removes its routines, histories and ingress secrets", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({ trigger: { kind: "webhook", filters: [] } }),
  );
  fixture.service.rotate(routine.id);
  fixture.service.enqueue(routine.id, "manual", "{}");
  await fixture.service.removeAgent(fixture.agent.id);
  expect(fixture.service.list(fixture.agent.id)).toEqual({
    routines: [],
    runs: [],
    events: [],
  });
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`, {
    readOnly: true,
  });
  expect(db.prepare("SELECT * FROM routine_secrets").all()).toEqual([]);
  db.close();
});

it("validates schedules and skips DST gaps while running a repeated wall time once", () => {
  expect(() => validateTrigger({ kind: "interval", minutes: 0 })).toThrow();
  expect(() =>
    validateTrigger({
      kind: "cron",
      expression: "* * * * * *",
      timezone: "UTC",
    }),
  ).toThrow();
  expect(() =>
    validateTrigger({
      kind: "cron",
      expression: "0 9 * * *",
      timezone: "invalid",
    }),
  ).toThrow();
  const spring = {
    kind: "cron",
    expression: "30 2 * * *",
    timezone: "America/New_York",
  } as const;
  expect(nextRoutineTime(spring, Date.parse("2026-03-08T05:00:00Z"))).toBe(
    "2026-03-09T06:30:00.000Z",
  );
  const autumn = {
    kind: "cron",
    expression: "30 1 * * *",
    timezone: "America/New_York",
  } as const;
  const first = nextRoutineTime(autumn, Date.parse("2026-11-01T04:00:00Z"));
  expect(first).toBe("2026-11-01T05:30:00.000Z");
  expect(nextRoutineTime(autumn, Date.parse(first!))).toBe(
    "2026-11-02T06:30:00.000Z",
  );
});

it("preserves interval cadence and applies offline catch-up once rather than replaying a backlog", async () => {
  await using fixture = await setup();
  const skip = fixture.service.save(fixture.agent.id, definition());
  const latest = fixture.service.save(
    fixture.agent.id,
    definition({ missed: "latest" }),
  );
  const due = Math.max(Date.parse(skip.nextAt!), Date.parse(latest.nextAt!));
  await fixture.service.tick(due + 2 * 3600000 + 10000, true);
  expect(
    fixture.service
      .list(fixture.agent.id)
      .runs.filter((run) => run.routineId === skip.id),
  ).toHaveLength(0);
  expect(
    fixture.service
      .list(fixture.agent.id)
      .runs.filter((run) => run.routineId === latest.id),
  ).toHaveLength(1);
  const next = fixture.service
    .list(fixture.agent.id)
    .routines.find((routine) => routine.id === latest.id)?.nextAt;
  expect(Date.parse(next!) - Date.parse(latest.nextAt!)).toBe(3 * 3600000);
});

it("rejects paused, stale, oversized and excessive webhook deliveries with no extra queued work", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({ trigger: { kind: "webhook", filters: [] } }),
  );
  const { secret } = fixture.service.rotate(routine.id);
  const body = Buffer.from("{}");
  const headers = (timestamp = String(Math.floor(Date.now() / 1000))) => ({
    "x-paws-timestamp": timestamp,
    "x-paws-signature": createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex"),
  });
  expect(() =>
    fixture.service.webhook(
      routine.id,
      headers(String(Math.floor(Date.now() / 1000) - 301)),
      body,
    ),
  ).toThrow("timestamp");
  expect(() =>
    fixture.service.webhook(routine.id, headers(), Buffer.alloc(262145)),
  ).toThrow();
  const paused = fixture.service.save(
    fixture.agent.id,
    { ...routine, enabled: false },
    routine.id,
    "user",
    routine.revision,
  );
  expect(() => fixture.service.webhook(routine.id, headers(), body)).toThrow(
    "paused",
  );
  fixture.service.save(
    fixture.agent.id,
    { ...paused, enabled: true },
    paused.id,
    "user",
    paused.revision,
  );

  for (let index = 0; index < 57; index++)
    fixture.service.webhook(routine.id, headers(), body);

  expect(() => fixture.service.webhook(routine.id, headers(), body)).toThrow(
    "rate limit",
  );
  expect(fixture.service.list(fixture.agent.id).runs).toHaveLength(57);
});

it("cancels a running routine and releases the agent execution slot", async () => {
  await using fixture = await setup(async (turn) => {
    if (!turn.text.includes("Paws routine")) return;

    await new Promise<void>((resolve) =>
      turn.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const routine = fixture.service.save(fixture.agent.id, definition());
  const run = fixture.service.enqueue(routine.id, "manual");
  await fixture.service.tick();
  await expect
    .poll(() => fixture.service.getRun(run.id).status)
    .toBe("running");
  await fixture.service.cancel(run.id);
  expect(fixture.service.getRun(run.id).status).toBe("cancelled");
  expect(fixture.service.conversations.busy(run.id)).toBe(false);
});

it("supplies event data to execution without duplicating raw payloads into retained chat messages", async () => {
  const calls: ChatTurn[] = [];
  await using fixture = await setup(async (turn) => {
    calls.push(turn);
    turn.onText("reply", "Done", true);
  });
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({ trigger: { kind: "webhook", filters: [] } }),
  );
  const run = fixture.service.enqueue(
    routine.id,
    "manual",
    '{"unique":"raw-event-value"}',
  );
  await fixture.service.tick();
  await expect
    .poll(() => fixture.service.getRun(run.id).status)
    .toBe("succeeded");
  expect(calls.at(-1)?.text).toContain("raw-event-value");
  expect(
    JSON.stringify(fixture.service.conversations.get(run.id)),
  ).not.toContain("raw-event-value");
});

it("delivers routine output as clean message text with separate provenance", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(fixture.agent.id, definition());
  const run = fixture.service.enqueue(routine.id, "manual");
  await fixture.service.tool(
    fixture.agent.id,
    { action: "message", text: "He was outstanding in his field." },
    run.id,
  );
  const message = fixture.main.get(fixture.agent.id).messages.at(-1);
  expect(message?.text).toBe("He was outstanding in his field.");
  expect(message).toMatchObject({ routine: { name: "Digest", runId: run.id } });
});

it("preserves webhook signatures after filter edits and revokes them when leaving webhook mode", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({ trigger: { kind: "webhook", filters: [] } }),
  );
  const { secret } = fixture.service.rotate(routine.id);
  const updated = fixture.service.save(
    fixture.agent.id,
    {
      ...routine,
      trigger: { kind: "webhook", eventType: "issue", filters: [] },
    },
    routine.id,
    "user",
    routine.revision,
  );
  const body = Buffer.from('{"type":"issue"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "x-paws-timestamp": timestamp,
    "x-paws-signature": createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex"),
  };
  expect(fixture.service.webhook(routine.id, headers, body).outcome).toBe(
    "accepted",
  );
  const interval = fixture.service.save(
    fixture.agent.id,
    { ...updated, trigger: { kind: "interval", minutes: 60 } },
    routine.id,
    "user",
    updated.revision,
  );
  fixture.service.save(
    fixture.agent.id,
    updated,
    routine.id,
    "user",
    interval.revision,
  );
  expect(() => fixture.service.webhook(routine.id, headers, body)).toThrow(
    "signature",
  );
});

it("rejects stale editor saves after a one-time schedule disables itself", async () => {
  await using fixture = await setup();
  const at = new Date(Date.now() + 60000).toISOString();
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({ trigger: { kind: "once", at }, missed: "latest" }),
  );
  await fixture.service.tick(Date.parse(at));
  expect(fixture.service.list(fixture.agent.id).routines[0]?.revision).toBe(
    routine.revision + 1,
  );
  expect(() =>
    fixture.service.save(
      fixture.agent.id,
      { ...routine, name: "Renamed" },
      routine.id,
      "user",
      routine.revision,
    ),
  ).toThrow("Routine changed");
  expect(fixture.service.list(fixture.agent.id).routines[0]?.enabled).toBe(
    false,
  );
  expect(fixture.service.list(fixture.agent.id).runs).toHaveLength(1);
});

it("bounds unauthenticated webhook history across restarts", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(
    fixture.agent.id,
    definition({ trigger: { kind: "webhook", filters: [] } }),
  );
  fixture.service.rotate(routine.id);

  for (
    let index = 0;
    index < fixture.service.limits.requestsPerMinute;
    index++
  ) {
    expect(() =>
      fixture.service.webhook(routine.id, {}, Buffer.from("{}")),
    ).toThrow("signature");
  }

  await fixture.reopen();

  for (let index = 0; index < 100; index++) {
    expect(() =>
      fixture.service.webhook(routine.id, {}, Buffer.from("{}")),
    ).toThrow("rate limit");
  }

  expect(
    fixture.service
      .list(fixture.agent.id)
      .events.filter((event) => event.outcome === "rejected_authentication"),
  ).toHaveLength(fixture.service.limits.requestsPerMinute);
  expect(fixture.service.list(fixture.agent.id).runs).toHaveLength(0);
});

it("expires waiting work and strips old payloads in the same retention pass", async () => {
  await using fixture = await setup();
  const routine = fixture.service.save(fixture.agent.id, definition());
  const run = fixture.service.enqueue(routine.id, "manual", "{}");
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const db = new DatabaseSync(`${fixture.root}/state.sqlite`);

  try {
    db.prepare("UPDATE routine_runs SET data = ? WHERE id = ?").run(
      JSON.stringify({
        ...run,
        status: "waiting",
        createdAt: old,
        finishedAt: old,
      }),
      run.id,
    );
  } finally {
    db.close();
  }

  await fixture.service.tick();
  expect(fixture.service.getRun(run.id)).toMatchObject({ status: "expired" });
  expect(fixture.service.getRun(run.id).payload).toBeUndefined();
  await expect(
    fixture.service.respond(run.id, {
      requestId: "late",
      text: "Continue",
      selection,
    }),
  ).rejects.toThrow("not available");
});
