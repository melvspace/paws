import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import {
  Agent,
  AgentAvatar,
  defaultAgentAvatar,
  type CreateAgent,
  type UpdateAgent,
} from "@paws/contracts";
import { provisionWorkspace } from "@paws/runtime";

function validateName(value: string) {
  const name = value.trim();

  if (!name || name.length > 80) {
    throw new Error("Use a name of 1–80 characters.");
  }

  return name;
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
        const agent = { ...existing, name, avatar };
        db.prepare("UPDATE agents SET data = ? WHERE id = ?").run(
          JSON.stringify(agent),
          id,
        );

        return agent;
      }),
  );

  const remove = Effect.fn("AgentService.remove")((id: string) =>
    Effect.try(
      () => db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes > 0,
    ),
  );

  return { list, create, update, remove, close: () => db.close() };
}
