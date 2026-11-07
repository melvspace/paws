import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import { EnvironmentIdentity, LinkedEnvironment } from "@paws/contracts";

const StoredLink = Schema.Struct({
  ...LinkedEnvironment.fields,
  token: Schema.String,
});

export function environmentUrl(value: string) {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTP or HTTPS environment address without a path.");

  return url.origin;
}

const hash = (value: string) => createHash("sha256").update(value).digest();

export function makeEnvironmentService(root: string, now = Date.now) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "environments.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, digest TEXT NOT NULL);
  `);

  const get = (key: string) =>
    db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;

  const set = (key: string, value: string) =>
    db.prepare("INSERT OR REPLACE INTO settings VALUES (?, ?)").run(key, value);
  const storedId = get("id");
  const id = typeof storedId === "string" ? storedId : randomUUID();
  set("id", id);
  let pairing: { digest: Buffer; expiresAt: number } | undefined;

  const identity = (): EnvironmentIdentity => ({
    id,
    name: String(get("name") ?? hostname()),
    platform: platform(),
  });

  const sharing = () => get("sharing") === "true";

  const list = () =>
    db
      .prepare("SELECT data FROM links ORDER BY rowid")
      .all()
      .map((row) =>
        Schema.decodeUnknownSync(StoredLink)(JSON.parse(String(row.data))),
      );

  const connections = () =>
    db
      .prepare("SELECT data FROM connections ORDER BY rowid")
      .all()
      .map((row) =>
        Schema.decodeUnknownSync(EnvironmentIdentity)(
          JSON.parse(String(row.data)),
        ),
      );

  const configure = Effect.fn("EnvironmentService.configure")(
    (input: { name?: string | undefined; sharing?: boolean | undefined }) =>
      Effect.sync(() => {
        if (input.name !== undefined) {
          const name = input.name.trim();

          if (!name || name.length > 80)
            throw new Error("Use a name of 1–80 characters.");

          set("name", name);
        }

        if (input.sharing !== undefined) {
          set("sharing", String(input.sharing));
          pairing = undefined;
        }
      }),
  );

  const createPairing = Effect.fn("EnvironmentService.createPairing")(() =>
    Effect.sync(() => {
      if (!sharing())
        throw new Error("Enable sharing before creating a pairing code.");

      const code = randomBytes(32).toString("base64url");
      const expiresAt = now() + 5 * 60_000;
      pairing = { digest: hash(code), expiresAt };

      return { code, expiresAt: new Date(expiresAt).toISOString() };
    }),
  );

  const grant = Effect.fn("EnvironmentService.grant")(
    (peer: EnvironmentIdentity) =>
      Effect.sync(() => {
        if (!sharing()) throw new Error("Environment sharing is disabled.");
        if (peer.id === id) throw new Error("This is the current environment.");

        const token = randomBytes(32).toString("base64url");
        db.prepare("INSERT OR REPLACE INTO connections VALUES (?, ?, ?)").run(
          peer.id,
          JSON.stringify(peer),
          hash(token).toString("hex"),
        );

        return { identity: identity(), token };
      }),
  );

  const pair = Effect.fn("EnvironmentService.pair")(
    (code: string, peer: EnvironmentIdentity) =>
      Effect.sync(() => {
        if (
          !sharing() ||
          !pairing ||
          pairing.expiresAt <= now() ||
          !timingSafeEqual(hash(code), pairing.digest)
        )
          throw new Error(
            "Pairing code is incorrect or expired. Create a new code on the other computer.",
          );
        if (peer.id === id) throw new Error("This is the current environment.");

        pairing = undefined;

        return Effect.runSync(grant(peer));
      }),
  );

  const authorize = (token: string) =>
    sharing() &&
    db
      .prepare("SELECT digest FROM connections")
      .all()
      .some((row) =>
        timingSafeEqual(hash(token), Buffer.from(String(row.digest), "hex")),
      );

  const remember = Effect.fn("EnvironmentService.remember")(
    (link: typeof StoredLink.Type) =>
      Effect.sync(() => {
        if (link.id === id) throw new Error("This is the current environment.");

        db.prepare("INSERT OR REPLACE INTO links VALUES (?, ?)").run(
          link.id,
          JSON.stringify(link),
        );
      }),
  );

  const setEnabled = Effect.fn("EnvironmentService.setEnabled")(
    (peerId: string, enabled: boolean) =>
      Effect.sync(() => {
        const link = list().find((item) => item.id === peerId);

        if (!link)
          throw new Error("Environment no longer exists. Reload the list.");

        db.prepare("UPDATE links SET data = ? WHERE id = ?").run(
          JSON.stringify({ ...link, enabled }),
          peerId,
        );
      }),
  );

  const forget = Effect.fn("EnvironmentService.forget")((peerId: string) =>
    Effect.sync(() => {
      db.prepare("DELETE FROM links WHERE id = ?").run(peerId);
    }),
  );

  const revoke = Effect.fn("EnvironmentService.revoke")((peerId: string) =>
    Effect.sync(() => {
      db.prepare("DELETE FROM connections WHERE id = ?").run(peerId);
    }),
  );

  return {
    identity,
    sharing,
    list,
    connections,
    configure,
    createPairing,
    pair,
    grant,
    authorize,
    remember,
    setEnabled,
    forget,
    revoke,
    close: () => db.close(),
  };
}
