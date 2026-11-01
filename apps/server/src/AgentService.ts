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
import { validateIntegrations } from "./teamIntegrations.ts";
import { provisionWorkspace } from "@paws/runtime";

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

export function makeAgentService(root: string) {
  Fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(Path.join(root, "state.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  db.exec(`
    UPDATE agents
    SET data = json_remove(
      data, '$.role', '$.personality', '$.specialization', '$.instructions'
    )
    WHERE json_type(data, '$.role') IS NOT NULL
       OR json_type(data, '$.personality') IS NOT NULL
       OR json_type(data, '$.specialization') IS NOT NULL
       OR json_type(data, '$.instructions') IS NOT NULL
  `);
  db.exec(`
    UPDATE agents
    SET data = json_set(data, '$.avatar.animal', 'mouse')
    WHERE json_extract(data, '$.avatar.animal') = 'tiger'
  `);
  db.exec(
    "CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
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
    (input: UpdateTeam, id?: string) =>
      Effect.try(() => {
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

        const team: Team = {
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
  const removeTeam = Effect.fn("AgentService.removeTeam")((id: string) =>
    Effect.try(() => {
      db.exec("BEGIN IMMEDIATE");

      try {
        const removed =
          db.prepare("DELETE FROM teams WHERE id = ?").run(id).changes > 0;

        for (const row of db.prepare("SELECT id, data FROM agents").all()) {
          const agent = Schema.decodeUnknownSync(Agent)(
            JSON.parse(String(row.data)),
          );

          if (agent.teamIds?.includes(id)) {
            db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(
              JSON.stringify({
                ...agent,
                teamIds: agent.teamIds.filter((teamId) => teamId !== id),
              }),
              String(row.id),
            );
          }
        }

        db.exec("COMMIT");

        return removed;
      } catch (error) {
        db.exec("ROLLBACK");

        throw error;
      }
    }),
  );

  function validateTeams(ids: readonly string[]) {
    if (ids.length > 20 || new Set(ids).size !== ids.length) {
      throw new Error("Choose up to 20 distinct teams.");
    }

    for (const id of ids) {
      if (!db.prepare("SELECT id FROM teams WHERE id = ?").get(id)) {
        throw new Error("Team not found.");
      }
    }

    return ids;
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
        ...(input.teamIds ? { teamIds: validateTeams(input.teamIds) } : {}),
        ...(input.memory !== undefined
          ? { memory: validateMemory(input.memory) }
          : {}),
        provider: "codex",
        status: "configured",
        createdAt: new Date().toISOString(),
      };
      const layout = await provisionWorkspace(root, agent.id);

      try {
        db.prepare("INSERT INTO agents (id, data) VALUES (?, ?)").run(
          agent.id,
          JSON.stringify(agent),
        );
      } catch (error) {
        await Fs.promises.rm(layout.base, { recursive: true, force: true });

        throw error;
      }

      return agent;
    }),
  );

  const update = Effect.fn("AgentService.update")(
    (id: string, input: UpdateAgent) =>
      Effect.try(() => {
        const name = validateName(input.name);
        const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(id);

        if (!row) {
          return null;
        }

        const existing = decode(JSON.parse(String(row.data)));
        const avatar = Schema.decodeUnknownSync(AgentAvatar)(
          input.avatar ?? existing.avatar ?? defaultAgentAvatar(id),
        );
        const agent = {
          ...existing,
          name,
          avatar,
          ...(input.teamIds ? { teamIds: validateTeams(input.teamIds) } : {}),
          ...(input.memory !== undefined
            ? { memory: validateMemory(input.memory) }
            : {}),
        };
        db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(
          JSON.stringify(agent),
          id,
        );

        return agent;
      }),
  );

  const moveTeam = Effect.fn("AgentService.moveTeam")(
    (id: string, input: MoveAgentTeam) =>
      Effect.try(() => {
        const row = db.prepare("SELECT data FROM agents WHERE id = ?").get(id);

        if (!row) throw new Error("Agent not found.");

        const agent = decode(JSON.parse(String(row.data)));
        const current = agent.teamIds ?? [];

        if (
          input.fromTeamId
            ? !current.includes(input.fromTeamId)
            : current.length > 0
        ) {
          throw new Error("Agent membership changed. Try moving it again.");
        }

        const teamIds = [
          ...new Set([
            ...current.filter((teamId) => teamId !== input.fromTeamId),
            ...(input.toTeamId !== null ? [input.toTeamId] : []),
          ]),
        ];
        validateTeams(teamIds);
        const moved = { ...agent, teamIds };
        db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(
          JSON.stringify(moved),
          id,
        );

        return moved;
      }),
  );

  const remove = Effect.fn("AgentService.remove")((id: string) =>
    Effect.try(
      () => db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0,
    ),
  );

  return {
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
