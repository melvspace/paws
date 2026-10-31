import * as Fs from "node:fs";
import * as Path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";
import {
  ProviderSnapshot,
  ProviderModel,
  type ProviderConfig,
  type ProviderDriver,
  type UpdateProvider,
  type UpdateProviderEnvironment,
} from "@paws/contracts";
import { providerDrivers, providerDriver } from "@paws/provider-core";
import { ProbeError } from "@paws/provider-core/process";
import { discoverProvider, signInProvider } from "@paws/provider-native";

import { isProviderInstalled } from "./installedProviders.ts";

export function makeProviderService(
  root: string,
  discover: typeof discoverProvider = discoverProvider,
  onChange: () => void = () => {},
  authenticate: typeof signInProvider = signInProvider,
  installed: (driver: ProviderDriver) => boolean = isProviderInstalled,
) {
  Fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(Path.join(root, "state.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  const firstRun = !db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'providers'",
    )
    .get();
  db.exec(
    "CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS provider_environment (provider_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(provider_id, name))",
  );
  Fs.chmodSync(Path.join(root, "state.sqlite"), 0o600);
  const decode = Schema.decodeUnknownSync(ProviderSnapshot);
  const states = new Map<string, ProviderSnapshot>();
  const active = new Map<
    string,
    { abort: AbortController; promise: Promise<ProviderSnapshot | null> }
  >();
  const logins = new Map<
    string,
    { abort: AbortController; task: Promise<void> }
  >();
  let closed = false;

  function persist(state: ProviderSnapshot) {
    db.prepare(
      "INSERT INTO providers(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
    ).run(state.config.id, JSON.stringify({ ...state, signIn: undefined }));
    states.set(state.config.id, state);
    onChange();

    return state;
  }

  for (const row of db
    .prepare("SELECT data FROM providers ORDER BY rowid")
    .all()) {
    const state = decode(JSON.parse(String(row.data)));
    states.set(state.config.id, {
      ...state,
      status: state.config.enabled ? "unchecked" : "disabled",
    });
  }

  function initial(config: ProviderConfig): ProviderSnapshot {
    return {
      config,
      status: config.enabled ? "unchecked" : "disabled",
      auth: "unknown",
      version: null,
      message: null,
      checkedAt: null,
      models: [],
    };
  }

  if (firstRun) {
    for (const driver of providerDrivers.filter((driver) =>
      installed(driver.id),
    )) {
      const config: ProviderConfig = {
        id: driver.id,
        driver: driver.id,
        name: driver.name,
        enabled: driver.id === "codex",
        binaryPath: "",
        args: [],
      };
      const state = initial(config);
      db.prepare("INSERT INTO providers(id,data) VALUES (?,?)").run(
        config.id,
        JSON.stringify(state),
      );
      states.set(config.id, state);
    }
  }

  // Legacy releases seeded every driver. Hide only untouched automatic entries;
  // explicitly added instances and configured providers remain available for setup.
  const list = () =>
    [...states.values()].filter((state) => {
      const { config } = state;
      const untouchedDefault =
        config.id === config.driver &&
        config.name === providerDriver(config.driver).name &&
        !config.enabled &&
        !config.binaryPath &&
        !config.homePath &&
        !config.args.length &&
        !state.environment?.length &&
        !state.checkedAt;

      return !untouchedDefault || installed(config.driver);
    });
  const create = Effect.fn("ProviderService.create")((driver: ProviderDriver) =>
    Effect.try(() => {
      const definition = providerDriver(driver);
      const id = randomUUID();
      const homePath = ["codex", "claudeAgent", "pi"].includes(driver)
        ? Path.join(root, "provider-homes", id)
        : "";

      if (homePath) Fs.mkdirSync(homePath, { recursive: true, mode: 0o700 });

      return persist(
        initial({
          id,
          ...(homePath ? { homePath } : {}),
          driver,
          name: definition.name,
          enabled: true,
          binaryPath: "",
          args: [],
        }),
      );
    }),
  );
  const update = Effect.fn("ProviderService.update")(
    (id: string, input: UpdateProvider) =>
      Effect.try(() => {
        const current = states.get(id);

        if (!current) return null;
        if (
          !input.name.trim() ||
          input.name.length > 80 ||
          input.binaryPath.length > 2048 ||
          (input.homePath?.length ?? 0) > 2048 ||
          input.homePath?.includes("\0") ||
          input.args.length > 32 ||
          input.args.some((arg) => arg.length > 2048 || arg.includes("\0")) ||
          input.binaryPath.includes("\0")
        ) {
          throw new Error("Invalid provider configuration.");
        }
        logins.get(id)?.abort.abort();
        logins.delete(id);
        active.get(id)?.abort.abort();
        active.delete(id);
        const config = {
          ...current.config,
          ...input,
          name: input.name.trim(),
          binaryPath: input.binaryPath.trim(),
        };

        const runtimeChanged =
          current.config.enabled !== config.enabled ||
          current.config.binaryPath !== config.binaryPath ||
          current.config.homePath !== config.homePath ||
          JSON.stringify(current.config.args) !== JSON.stringify(config.args);

        return persist(
          runtimeChanged
            ? { ...initial(config), environment: current.environment ?? [] }
            : {
                ...current,
                signIn: undefined,
                config,
                status:
                  current.status === "checking" ? "unchecked" : current.status,
              },
        );
      }),
  );
  const remove = Effect.fn("ProviderService.remove")((id: string) =>
    Effect.try(() => {
      logins.get(id)?.abort.abort();
      logins.delete(id);
      active.get(id)?.abort.abort();
      active.delete(id);
      const removed =
        db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes > 0;
      db.prepare("DELETE FROM provider_environment WHERE provider_id = ?").run(
        id,
      );
      states.delete(id);
      onChange();

      return removed;
    }),
  );

  const setEnvironment = Effect.fn("ProviderService.setEnvironment")(
    (id: string, input: UpdateProviderEnvironment) =>
      Effect.try(() => {
        const current = states.get(id);

        if (!current) return null;
        if (
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.name) ||
          (input.value?.length ?? 0) > 32768 ||
          input.value?.includes("\0")
        )
          throw new Error("Invalid environment variable.");
        logins.get(id)?.abort.abort();
        logins.delete(id);
        active.get(id)?.abort.abort();
        active.delete(id);

        if (input.value === null)
          db.prepare(
            "DELETE FROM provider_environment WHERE provider_id = ? AND name = ?",
          ).run(id, input.name);
        else
          db.prepare(
            "INSERT INTO provider_environment(provider_id, name, value) VALUES (?,?,?) ON CONFLICT(provider_id,name) DO UPDATE SET value=excluded.value",
          ).run(id, input.name, input.value);

        const environment = db
          .prepare(
            "SELECT name FROM provider_environment WHERE provider_id = ? ORDER BY name",
          )
          .all(id)
          .map((row) => String(row.name));

        return persist({ ...initial(current.config), environment });
      }),
  );

  function refresh(id: string): Promise<ProviderSnapshot | null> {
    if (logins.has(id)) return Promise.resolve(states.get(id) ?? null);

    const running = active.get(id);

    if (running) return running.promise;

    const current = states.get(id);

    if (!current || !current.config.enabled || closed)
      return Promise.resolve(current ?? null);

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    const checking = {
      ...current,
      signIn: undefined,
      status: "checking" as const,
      message: null,
    };
    states.set(id, checking);
    onChange();
    const promise = (async () => {
      const cwd = Path.join(root, "provider-probes", id);
      let result: ProviderSnapshot;

      try {
        Fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const environment = Object.fromEntries(
          db
            .prepare(
              "SELECT name, value FROM provider_environment WHERE provider_id = ?",
            )
            .all(id)
            .map((row) => [String(row.name), String(row.value)]),
        );
        const discovery = await discover(
          current.config,
          cwd,
          abort.signal,
          environment,
        );
        const models = Schema.decodeUnknownSync(Schema.Array(ProviderModel))(
          discovery.models,
        );
        const unique = [
          ...new Map(models.map((model) => [model.id, model])).values(),
        ];
        result = {
          ...checking,
          auth: discovery.auth,
          account:
            discovery.auth === "authenticated" ? discovery.account : undefined,
          version: discovery.version,
          status:
            discovery.auth === "unauthenticated"
              ? "needs-auth"
              : unique.length
                ? "ready"
                : "error",
          message:
            discovery.auth === "unauthenticated"
              ? "Sign in, then refresh."
              : unique.length
                ? null
                : "The provider returned no models.",
          models: discovery.auth === "unauthenticated" ? [] : unique,
          checkedAt: new Date().toISOString(),
        };
      } catch (error) {
        const missing = error instanceof ProbeError && error.kind === "missing";
        const authentication =
          error instanceof Error && error.name === "AuthenticationError";
        result = {
          ...checking,
          models: [],
          auth: authentication ? "unauthenticated" : "unknown",
          account: undefined,
          status: missing ? "missing" : authentication ? "needs-auth" : "error",
          message: missing
            ? "Executable not found. Install the provider or set its binary path."
            : authentication
              ? "Sign in, then refresh."
              : error instanceof ProbeError
                ? error.message
                : "Discovery failed. Check the provider's setup and refresh.",
          checkedAt: new Date().toISOString(),
        };
      } finally {
        clearTimeout(timeout);
      }

      // A concurrent disable, edit, removal, or shutdown owns the newer state.
      if (closed || active.get(id)?.abort !== abort)
        return states.get(id) ?? null;
      active.delete(id);

      return persist(result);
    })();
    active.set(id, { abort, promise });

    return promise;
  }

  function cancelSignIn(id: string) {
    logins.get(id)?.abort.abort();
    logins.delete(id);
    const current = states.get(id);

    if (current) {
      const { signIn: _signIn, ...next } = current;
      states.set(id, next);
      onChange();
    }

    return states.get(id) ?? null;
  }

  function startSignIn(id: string) {
    const current = states.get(id);

    if (!current || !current.config.enabled) return null;
    if (!["codex", "cursor"].includes(current.config.driver))
      throw new Error("Use native CLI sign-in.");
    if (logins.has(id)) return current;

    active.get(id)?.abort.abort();
    active.delete(id);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5 * 60_000);
    const next: ProviderSnapshot = {
      ...current,
      signIn: { phase: "starting", url: null, code: null },
    };
    states.set(id, next);
    onChange();
    const task = Promise.resolve().then(async () => {
      const cwd = Path.join(root, "provider-probes", id);

      try {
        Fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const environment = Object.fromEntries(
          db
            .prepare(
              "SELECT name,value FROM provider_environment WHERE provider_id = ?",
            )
            .all(id)
            .map((row) => [String(row.name), String(row.value)]),
        );

        await authenticate(
          current.config,
          cwd,
          abort.signal,
          environment,
          (url, code) => {
            if (closed || logins.get(id)?.abort !== abort) return;
            if (!URL.canParse(url) || new URL(url).protocol !== "https:")
              throw new Error("Invalid sign-in URL.");
            states.set(id, {
              ...next,
              signIn: { phase: "waiting", url, code: code ?? null },
            });
            onChange();
          },
        );

        if (!closed && logins.get(id)?.abort === abort) {
          cancelSignIn(id);
          await refresh(id);
        }
      } catch {
        if (!closed && logins.get(id)?.abort === abort) {
          logins.delete(id);
          states.set(id, {
            ...current,
            signIn: { phase: "error", url: null, code: null },
          });
          onChange();
        }
      } finally {
        clearTimeout(timer);
      }
    });
    logins.set(id, { abort, task });

    return next;
  }

  return {
    list,
    // Server-only access; never include values in snapshots or HTTP responses.
    environment(id: string): Record<string, string> {
      return Object.fromEntries(
        db
          .prepare(
            "SELECT name,value FROM provider_environment WHERE provider_id = ?",
          )
          .all(id)
          .map((row) => [String(row.name), String(row.value)]),
      );
    },
    create,
    update,
    remove,
    setEnvironment,
    refresh,
    startSignIn,
    cancelSignIn,
    async close() {
      closed = true;
      const signingIn = [...logins.values()];
      for (const login of signingIn) login.abort.abort();
      logins.clear();
      const pending = [...active.values()];
      active.clear();

      for (const task of pending) task.abort.abort();
      await Promise.allSettled(pending.map((task) => task.promise));
      await Promise.allSettled(signingIn.map((login) => login.task));
      db.close();
    },
  };
}
