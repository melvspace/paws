import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const record = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown),
);

// Preserve original records so retired integrations and extra memberships remain
// recoverable without exposing them through the current wire contracts.
export function migrateAgents(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS environment_migration_archive (entity TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY (entity, id))",
    );

    for (const table of ["agents", "teams"]) {
      for (const row of db.prepare(`SELECT id, data FROM ${table}`).all()) {
        const data = { ...record(JSON.parse(String(row.data))) };
        let changed = false;

        if (
          table === "agents" &&
          ("teamIds" in data || (!("teamId" in data) && !("sandbox" in data)))
        ) {
          const memberships = Schema.decodeUnknownSync(
            Schema.Array(Schema.String),
          )(data.teamIds ?? []);

          if (!("teamId" in data)) data.teamId = memberships[0] ?? null;

          if (!("sandbox" in data)) data.sandbox = true;

          delete data.teamIds;
          changed = true;
        } else if (table === "teams" && Array.isArray(data.integrations)) {
          const integrations = data.integrations.map((item) => record(item));

          if (integrations.some((item) => item.kind === "cli")) {
            data.integrations = integrations.filter(
              (item) => item.kind !== "cli",
            );
            changed = true;
          }
        }

        if (!changed) continue;

        db.prepare(
          "INSERT OR IGNORE INTO environment_migration_archive (entity, id, data) VALUES (?, ?, ?)",
        ).run(table, String(row.id), String(row.data));
        db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`).run(
          JSON.stringify(data),
          String(row.id),
        );
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");

    throw error;
  }
}
