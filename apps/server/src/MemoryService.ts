import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import {
  Agent,
  essentialMemoryOwnerBudgetBytes,
  essentialMemoryOwnerLimit,
  Team,
  type MemoryEntry,
  type MemoryRequest,
} from "@paws/contracts";

export type MemoryOwner = { kind: "agents" | "teams"; id: string };

export function ownerMemories(owner: Agent | Team): readonly MemoryEntry[] {
  const legacy = owner.memory?.trim();

  return [
    ...(legacy
      ? [
          {
            id: "legacy",
            text: legacy,
            inclusion: "searchable" as const,
            createdAt: owner.createdAt,
            updatedAt: owner.createdAt,
          },
        ]
      : []),
    ...(owner.memories ?? []).map((entry) => ({
      ...entry,
      inclusion: entry.inclusion ?? "searchable",
    })),
  ];
}

export function makeMemoryService(root: string) {
  const execute = Effect.fn("MemoryService.execute")(
    (owner: MemoryOwner, input: MemoryRequest) =>
      Effect.try({
        try: () => {
          const db = new DatabaseSync(join(root, "state.sqlite"));

          try {
            db.exec("BEGIN IMMEDIATE");
            const row = db
              .prepare(`SELECT data FROM ${owner.kind} WHERE id = ?`)
              .get(owner.id);

            if (!row) throw new Error("Memory owner no longer exists.");

            const data = JSON.parse(String(row.data));
            const current =
              owner.kind === "agents"
                ? Schema.decodeUnknownSync(Agent)(data)
                : Schema.decodeUnknownSync(Team)(data);
            const entries = [...ownerMemories(current)];

            if (input.action === "search") {
              const terms = [
                ...new Set(
                  input.query
                    ?.normalize("NFKC")
                    .toLocaleLowerCase()
                    .match(/[\p{L}\p{N}]+/gu) ?? [],
                ),
              ];
              const limit = input.limit ?? 5;

              if (!terms.length || (input.query?.length ?? 0) > 200)
                throw new Error(
                  "Use a search query of 1–200 characters containing words.",
                );

              if (!Number.isInteger(limit) || limit < 1 || limit > 10)
                throw new Error("Search limit must be an integer of 1–10.");

              const matches = entries
                .map((entry) => {
                  const text = entry.text.normalize("NFKC").toLocaleLowerCase();
                  const score = terms.reduce(
                    (count, term) => count + text.split(term).length - 1,
                    0,
                  );

                  return { entry, text, score };
                })
                .filter(({ text }) =>
                  terms.every((term) => text.includes(term)),
                )
                .sort(
                  (left, right) =>
                    right.score - left.score ||
                    right.entry.updatedAt.localeCompare(left.entry.updatedAt),
                )
                .slice(0, limit)
                .map(({ entry }) => entry);
              db.exec("COMMIT");

              return matches;
            }

            if (input.action === "read") {
              const entry = entries.find((entry) => entry.id === input.id);

              if (!entry) throw new Error("Memory no longer exists.");

              db.exec("COMMIT");

              return [entry];
            }

            if (input.action !== "list") {
              const index = entries.findIndex((entry) => entry.id === input.id);

              if (input.action !== "create") {
                if (index < 0)
                  throw new Error("Memory no longer exists. Reload memories.");
                if (entries[index]!.text !== input.expected)
                  throw new Error(
                    "Memory changed. Reload memories before editing it.",
                  );
              }

              if (input.action === "delete") {
                entries.splice(index, 1);
              } else {
                const text = input.text?.trim();

                if (!text || text.length > 16000)
                  throw new Error("Use a memory of 1–16000 characters.");

                const now = new Date().toISOString();
                const entry: MemoryEntry = {
                  id:
                    input.action === "create"
                      ? randomUUID()
                      : entries[index]!.id,
                  text,
                  inclusion:
                    input.inclusion ??
                    (input.action === "create"
                      ? "searchable"
                      : (entries[index]!.inclusion ?? "searchable")),
                  createdAt:
                    input.action === "create" ? now : entries[index]!.createdAt,
                  updatedAt: now,
                };

                if (input.action === "create") entries.push(entry);
                else entries[index] = entry;
              }

              if (
                entries.length > 256 ||
                entries.reduce((size, entry) => size + entry.text.length, 0) >
                  64000
              )
                throw new Error(
                  "Memories exceed the limit of 256 entries or 64000 characters.",
                );

              const essential = entries.filter(
                (entry) => entry.inclusion === "essential",
              );

              if (
                essential.length > essentialMemoryOwnerLimit ||
                Buffer.byteLength(JSON.stringify(essential)) >
                  essentialMemoryOwnerBudgetBytes
              )
                throw new Error(
                  "Essential memories are limited to 4 entries and 2048 bytes per owner. Keep other memories searchable.",
                );

              db.prepare(
                `UPDATE ${owner.kind} SET data = json_set(data, '$.memory', '', '$.memories', json(?)) WHERE id = ?`,
              ).run(JSON.stringify(entries), owner.id);
            }

            db.exec("COMMIT");

            return entries;
          } finally {
            db.close();
          }
        },
        catch: (cause) =>
          cause instanceof Error
            ? cause
            : new Error("Memory operation failed."),
      }),
  );

  return { execute };
}
