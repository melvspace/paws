import * as Fs from "node:fs";
import { join } from "node:path";
import { assertAgentId } from "@paws/shared";
import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";

const record = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown),
);

// Preserve original records so retired integrations and extra memberships remain
// recoverable without exposing them through the current wire contracts.
export function migrateAgents(db: DatabaseSync, root: string) {
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
        }

        if (table === "agents" && data.avatar !== undefined) {
          const avatar = record(data.avatar);

          if (avatar.animal === "tiger") {
            data.avatar = { ...avatar, animal: "mouse" };
            changed = true;
          }
        }

        if (table === "teams" && Array.isArray(data.integrations)) {
          const integrations = data.integrations.map((item) => record(item));

          if (integrations.some((item) => item.kind === "cli")) {
            data.integrations = integrations.filter(
              (item) => item.kind !== "cli",
            );
            changed = true;
          }
        }

        if (table === "teams" && data.template === undefined) {
          data.template = legacyTeamImage(root, String(row.id));
          changed = true;
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

// Import the old committed image once, into server-owned SQLite state. Never
// consult a mutable file inside a mounted team directory during execution.
function legacyTeamImage(root: string, teamId: string) {
  assertAgentId(teamId);
  const descriptors: number[] = [];
  const descriptorRoot =
    process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";

  try {
    let directory = root;

    for (const part of ["", "teams", teamId]) {
      if (part) directory = join(directory, part);

      const descriptor = Fs.openSync(
        directory,
        Fs.constants.O_RDONLY |
          Fs.constants.O_DIRECTORY |
          Fs.constants.O_NOFOLLOW,
      );
      descriptors.push(descriptor);
      directory = join(descriptorRoot, String(descriptor));
    }

    const descriptor = Fs.openSync(
      join(directory, "environment.json"),
      Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW | Fs.constants.O_NONBLOCK,
    );
    descriptors.push(descriptor);
    const stat = Fs.fstatSync(descriptor);

    if (!stat.isFile() || stat.size > 65536)
      throw new Error("Invalid team environment image.");

    const image = Schema.decodeUnknownSync(
      Schema.Struct({ image: Schema.String }),
    )(JSON.parse(Fs.readFileSync(descriptor, "utf8"))).image;

    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new Error("Invalid team environment image.");

    return image;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "paws-team-runtime:1";

    throw error;
  } finally {
    for (const descriptor of descriptors.reverse()) Fs.closeSync(descriptor);
  }
}
