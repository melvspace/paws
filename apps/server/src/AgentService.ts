import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import {
  Agent,
  AgentAvatar,
  defaultAgentAvatar,
  Team,
  type UpdateTeam,
  type MoveAgentTeam,
  type CreateAgent,
  type UpdateAgent,
} from "@paws/contracts";
import { migrateAgents } from "./agentMigration.ts";
import { validateIntegrations } from "./teamIntegrations.ts";
import {
  provisionWorkspace,
  workspaceLayout,
  placeWorkspace,
  stopEnvironment,
} from "@paws/runtime";

function validateName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Use a name of 1–80 characters.");
  }

  return name;
}

function validateMemory(memory: string) {
  if (memory.length > 16000)
    throw new Error("Memory must be at most 16000 characters.");

  return memory.trim();
}

export function makeAgentService(
  root: string,
  isIdle: (id: string) => boolean = () => true,
  closeExecution: (id: string) => Promise<void> = async () => {},
) {
  Fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(Path.join(root, "state.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  try {
    migrateAgents(db, root);
  } catch (error) {
    db.close();

    throw error;
  }
  const transitions = new Set<string>();
  const deletingTeams = new Set<string>();
  const pendingTeams = new Map<string, string | null>();

  const decodeTeam = Schema.decodeUnknownSync(Team);
  const listTeams = Effect.fn("AgentService.listTeams")(() =>
    Effect.try(() =>
      db
        .prepare("SELECT data FROM teams ORDER BY rowid")
        .all()
        .map((row) => decodeTeam(JSON.parse(String(row.data)))),
    ),
  );
  const saveTeam = Effect.fn("AgentService.saveTeam")(
    (input: UpdateTeam & { template?: string | undefined }, id?: string) =>
      Effect.try(() => {
        if (id && deletingTeams.has(id))
          throw new Error("Team environment is changing.");

        const row = id
          ? db.prepare("SELECT data FROM teams WHERE id = ?").get(id)
          : undefined;

        if (id && !row) return null;

        const current = row
          ? decodeTeam(JSON.parse(String(row.data)))
          : undefined;

        for (const key of ["name", "memory", "integrations"] as const) {
          if (
            input.expected &&
            key in input.expected &&
            JSON.stringify(input.expected[key]) !==
              JSON.stringify(
                current?.[key] ?? (key === "integrations" ? [] : undefined),
              )
          )
            throw new Error(
              "Team changed. Reopen it before retrying this edit.",
            );
        }

        const image = input.template;

        if (
          image !== undefined &&
          (typeof image !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image))
        ) {
          throw new Error("Use a container image name or digest.");
        }

        const team: Team = {
          template:
            current?.template ??
            (typeof image === "string" ? image : "paws-team-runtime:1"),
          id: id ?? Crypto.randomUUID(),
          name: validateName(input.name ?? current?.name ?? ""),
          memory: validateMemory(input.memory ?? current?.memory ?? ""),
          integrations: validateIntegrations(
            input.integrations ?? current?.integrations ?? [],
          ),
          createdAt: current?.createdAt ?? new Date().toISOString(),
        };
        const base = Path.join(root, "teams", team.id);

        for (const folder of ["skills", "files"]) {
          Fs.mkdirSync(Path.join(base, folder), {
            recursive: true,
            mode: 0o700,
          });
        }

        if (row) {
          const result = db
            .prepare("UPDATE teams SET data = ? WHERE id = ? AND data = ?")
            .run(JSON.stringify(team), team.id, String(row.data));

          if (!result.changes)
            throw new Error("Team changed. Retry this edit.");
        } else {
          db.prepare("INSERT INTO teams (id, data) VALUES (?, ?)").run(
            team.id,
            JSON.stringify(team),
          );
        }

        return team;
      }),
  );
  const removeTeam = Effect.fn("AgentService.removeTeam")(
    (id: string, cleanup: () => Promise<void> = async () => {}) =>
      Effect.tryPromise(async () => {
        if (deletingTeams.has(id))
          throw new Error("Team environment is changing.");

        if (!db.prepare("SELECT id FROM teams WHERE id = ?").get(id))
          return false;

        const members = db
          .prepare(
            "SELECT id FROM agents WHERE json_extract(data, '$.teamId') = ?",
          )
          .all(id);

        if (members.length || [...pendingTeams.values()].includes(id))
          throw new Error("Move the team's agents before deleting it.");

        deletingTeams.add(id);

        try {
          await cleanup();
          await stopEnvironment(root, id, "team");

          return (
            db.prepare("DELETE FROM teams WHERE id = ?").run(id).changes > 0
          );
        } finally {
          deletingTeams.delete(id);
        }
      }),
  );

  function validateTeam(id: string | null) {
    if (id && deletingTeams.has(id))
      throw new Error("Team environment is changing.");

    if (
      id !== null &&
      !db.prepare("SELECT id FROM teams WHERE id = ?").get(id)
    ) {
      throw new Error("Team not found.");
    }

    return id;
  }

  function requireIdle(id: string) {
    if (transitions.has(id) || !isIdle(id))
      throw new Error("Only idle agents can change environments.");
  }

  const decode = Schema.decodeUnknownSync(Agent);
  const list = Effect.fn("AgentService.list")(() =>
    Effect.try(() =>
      db
        .prepare("SELECT data FROM agents ORDER BY rowid")
        .all()
        .map((row) => decode(JSON.parse(String(row.data)))),
    ),
  );
  const create = Effect.fn("AgentService.create")((input: CreateAgent) =>
    Effect.tryPromise(async () => {
      const name = validateName(input.name);
      const id = Crypto.randomUUID();
      const avatar = Schema.decodeUnknownSync(AgentAvatar)(
        input.avatar ?? defaultAgentAvatar(id),
      );

      const agent: Agent = {
        name,
        id,
        avatar,
        teamId: validateTeam(input.teamId ?? null),
        sandbox: input.sandbox ?? false,
        ...(input.memory !== undefined
          ? { memory: validateMemory(input.memory) }
          : {}),
        provider: "codex",
        status: "configured",
        createdAt: new Date().toISOString(),
      };
      pendingTeams.set(id, agent.teamId ?? null);

      try {
        await provisionWorkspace(root, agent.id, agent.teamId);
        const layout = workspaceLayout(root, agent.id);

        try {
          db.prepare("INSERT INTO agents (id, data) VALUES (?, ?)").run(
            agent.id,
            JSON.stringify(agent),
          );
        } catch (error) {
          const actual = await Fs.promises.realpath(layout.base);
          await Fs.promises.unlink(layout.base);
          await Fs.promises.rm(actual, { recursive: true, force: true });

          throw error;
        }

        return agent;
      } finally {
        pendingTeams.delete(id);
      }
    }),
  );

  const update = Effect.fn("AgentService.update")(
    (id: string, input: UpdateAgent) =>
      Effect.tryPromise(async () => {
        const name = validateName(input.name);
        const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(id);

        if (!row) {
          return null;
        }

        if (transitions.has(id))
          throw new Error("Agent environment is changing.");

        const existing = decode(JSON.parse(String(row.data)));
        if (input.sandbox !== undefined && input.sandbox !== existing.sandbox) {
          requireIdle(id);

          if (existing.teamId)
            throw new Error("Team agents use their team's environment.");
        }

        const avatar = Schema.decodeUnknownSync(AgentAvatar)(
          input.avatar ?? existing.avatar ?? defaultAgentAvatar(id),
        );
        const agent = {
          ...existing,
          name,
          avatar,
          ...(input.sandbox !== undefined ? { sandbox: input.sandbox } : {}),
          ...(input.memory !== undefined
            ? { memory: validateMemory(input.memory) }
            : {}),
        };
        const changing =
          input.sandbox !== undefined && input.sandbox !== existing.sandbox;

        if (changing) transitions.add(id);

        try {
          if (changing) await closeExecution(id);

          if (changing && existing.sandbox)
            await stopEnvironment(root, id, "agent");

          db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(
            JSON.stringify(agent),
            id,
          );
        } finally {
          if (changing) transitions.delete(id);
        }

        return agent;
      }),
  );

  const moveTeam = Effect.fn("AgentService.moveTeam")(
    (id: string, input: MoveAgentTeam) =>
      Effect.tryPromise(async () => {
        const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(id);

        if (!row) throw new Error("Agent not found.");

        const agent = decode(JSON.parse(String(row.data)));
        requireIdle(id);

        if ((agent.teamId ?? null) !== input.fromTeamId) {
          throw new Error("Agent membership changed. Try moving it again.");
        }

        const teamId = validateTeam(input.toTeamId);
        transitions.add(id);
        pendingTeams.set(id, teamId);

        try {
          await closeExecution(id);

          if (!agent.teamId && agent.sandbox)
            await stopEnvironment(root, id, "agent");

          validateTeam(teamId);
          placeWorkspace(root, id, teamId);
          const moved = { ...agent, teamId };
          try {
            db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(
              JSON.stringify(moved),
              id,
            );
          } catch (error) {
            placeWorkspace(root, id, agent.teamId ?? null);

            throw error;
          }

          return moved;
        } finally {
          pendingTeams.delete(id);
          transitions.delete(id);
        }
      }),
  );

  const remove = Effect.fn("AgentService.remove")(
    (id: string, cleanup: () => Promise<void> = async () => {}) =>
      Effect.tryPromise(async () => {
        if (transitions.has(id))
          throw new Error("Agent environment is changing.");

        if (!db.prepare("SELECT id FROM agents WHERE id = ?").get(id))
          return false;

        transitions.add(id);

        try {
          await cleanup();
          await closeExecution(id);
          await stopEnvironment(root, id, "agent");

          return (
            db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0
          );
        } finally {
          transitions.delete(id);
        }
      }),
  );

  return {
    changing: (id: string) => transitions.has(id),
    list,
    create,
    update,
    remove,
    moveTeam,
    listTeams,
    saveTeam,
    removeTeam,
    close: () => db.close(),
  };
}
