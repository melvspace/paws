import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import * as Fs from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { assertAgentId } from "@paws/shared";
import { ChatToolError } from "@paws/provider-core";

const exec = promisify(execFile);
const starts = new Map<string, Promise<unknown>>();
const launches = new Map<string, { root: string; ready: Promise<void> }>();
const Result = Schema.Struct({
  status: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  exitCode: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
});
const Session = Schema.Struct({
  sessionId: Schema.String,
  teamId: Schema.String,
  integrationId: Schema.String,
  args: Schema.Array(Schema.String),
  configurationFingerprint: Schema.optional(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.String,
  redactions: Schema.optional(Schema.Array(Schema.String)),
  result: Schema.optional(Result),
  launching: Schema.optional(Schema.Boolean),
});
type Session = typeof Session.Type;

function redactSecrets(text: string, values: readonly string[]) {
  let output = text;

  for (const value of values) {
    if (value) output = output.split(value).join("[redacted]");
  }

  let suffix = 0;

  for (const value of values) {
    for (let length = value.length - 1; length > 0; length--) {
      if (output.endsWith(value.slice(0, length))) {
        suffix = Math.max(suffix, length);

        break;
      }
    }
  }

  return suffix ? output.slice(0, -suffix) + "[redacted]" : output;
}

const directory = (root: string) => join(root, "runtime", "team-sessions");
const container = (id: string) => `paws-session-${id}`;

function save(root: string, session: Session) {
  Fs.mkdirSync(directory(root), { recursive: true, mode: 0o700 });
  const path = join(directory(root), `${session.sessionId}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;

  try {
    Fs.writeFileSync(temporary, JSON.stringify(session), {
      mode: 0o600,
      flag: "wx",
    });
    Fs.renameSync(temporary, path);
  } finally {
    Fs.rmSync(temporary, { force: true });
  }
}

function load(root: string, id: string) {
  assertAgentId(id);
  const session = Schema.decodeUnknownSync(Session)(
    JSON.parse(Fs.readFileSync(join(directory(root), `${id}.json`), "utf8")),
  );

  if (session.sessionId !== id) throw new Error("Invalid command session.");

  return session;
}

function all(root: string) {
  if (!Fs.existsSync(directory(root))) return [];

  return Fs.readdirSync(directory(root))
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => load(root, name.slice(0, -5)));
}

export function listTeamCommands(root: string, teamId: string) {
  return all(root)
    .filter((session) => session.teamId === teamId)
    .map(
      ({
        sessionId,
        integrationId,
        createdAt,
        expiresAt,
        result,
        launching,
      }) => ({
        sessionId,
        integrationId,
        createdAt,
        expiresAt,
        status: result?.status ?? (launching ? "starting" : "running"),
      }),
    );
}

export function commandIntegration(root: string, teamId: string, id: string) {
  const session = load(root, id);

  if (session.teamId !== teamId)
    throw new ChatToolError("Command session belongs to another team.");

  return session.integrationId;
}

async function remove(id: string) {
  try {
    await exec("docker", ["rm", "--force", container(id)], { timeout: 10000 });
  } catch (error) {
    if (!missingContainer(error)) throw error;
  }
}

function missingContainer(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    /No such (container|object)/i.test(error.stderr)
  );
}

// Read only a bounded tail. Discard partial oversized lines so a truncated
// credential cannot bypass redaction at the beginning of the retained buffer.
async function logs(id: string) {
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const dropping = { stdout: false, stderr: false };
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    const child = spawn("docker", ["logs", container(id)], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    const capture = (chunk: Buffer, error: boolean) => {
      const stream = error ? "stderr" : "stdout";
      let incoming = chunk.toString("utf8");

      if (dropping[stream]) {
        const newline = incoming.indexOf("\n");

        if (newline < 0) return;

        incoming = incoming.slice(newline + 1);
        dropping[stream] = false;
      }

      let text = (error ? stderr : stdout) + incoming;

      if (text.length > 64000) {
        truncated = true;
        text = text.slice(-64000);
        const newline = text.indexOf("\n");
        dropping[stream] = newline < 0;
        text = newline < 0 ? "" : text.slice(newline + 1);
      }

      if (error) stderr = text;
      else stdout = text;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, true));
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new ChatToolError(
            "Cannot read command output. Check Docker availability.",
          ),
        );
      else resolve();
    });
  });

  return { stdout, stderr, truncated };
}

export async function readTeamCommand(
  root: string,
  teamId: string,
  id: string,
  redact: (text: string) => string,
  cancel = false,
  waitMs = 10000,
) {
  commandIntegration(root, teamId, id);
  const launch = launches.get(id);

  if (launch) {
    if (cancel) await launch.ready;
    else
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        launch.ready.then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
  }

  const session = load(root, id);

  if (launches.has(id) && !session.result) {
    return {
      sessionId: id,
      integrationId: session.integrationId,
      expiresAt: session.expiresAt,
      status: "starting" as const,
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      message:
        "Docker is preparing the command container. Read this session again for progress; do not start another login.",
    };
  }
  const redactOutput = (text: string) =>
    redact(redactSecrets(text, session.redactions ?? []));
  let result = session.result;

  if (!result) {
    let state: { Status: string; ExitCode: number };

    try {
      if (cancel) {
        state = { Status: "running", ExitCode: 0 };
      } else {
        const inspected = await exec(
          "docker",
          ["inspect", "--format", "{{json .State}}", container(id)],
          { timeout: 10000 },
        );
        state = Schema.decodeUnknownSync(
          Schema.Struct({ Status: Schema.String, ExitCode: Schema.Number }),
        )(JSON.parse(inspected.stdout));
      }
    } catch (error) {
      if (missingContainer(error)) {
        state = { Status: "missing", ExitCode: 127 };
      } else {
        throw new ChatToolError(
          "Cannot inspect command session. Check Docker availability; the session has not been replaced.",
        );
      }
    }

    const output =
      state.Status === "missing"
        ? {
            stdout: "",
            stderr:
              "Command container is no longer available. Start a new session.",
            truncated: false,
          }
        : await logs(id).catch((error: unknown) => {
            if (!cancel) throw error;

            return { stdout: "", stderr: "", truncated: false };
          });
    const running = ["running", "created", "restarting"].includes(state.Status);
    result = {
      status: cancel
        ? "cancelled"
        : running
          ? "running"
          : state.ExitCode === 0
            ? "completed"
            : "failed",
      exitCode: cancel || running ? null : state.ExitCode,
      stdout: redactOutput(output.stdout),
      stderr:
        redactOutput(output.stderr) +
        (!running && state.ExitCode === 124
          ? "\nCommand session expired after 30 minutes."
          : ""),
      truncated: output.truncated,
    };
    result = load(root, id).result ?? result;

    if (result.status !== "running") {
      // Keep a redacted terminal result before removing the container, allowing
      // another turn or a server restart to read completion without losing it.
      if (cancel) await remove(id);

      result = load(root, id).result ?? result;
      save(root, { ...session, redactions: [], result });

      if (!cancel) await remove(id).catch(() => {});
    }
  }

  return {
    sessionId: id,
    integrationId: session.integrationId,
    expiresAt: session.expiresAt,
    ...result,
    stdout: redactOutput(result.stdout),
    stderr: redactOutput(result.stderr),
    ...(result.status === "failed" ? { isError: true } : {}),
  };
}

export async function startTeamCommand(input: {
  root: string;
  teamId: string;
  integrationId: string;
  commandArgs: string[];
  args: readonly string[];
  image: string;
  secrets: Record<string, string>;
  signal: AbortSignal;
  redact: (text: string) => string;
}) {
  const imageIndex = input.commandArgs.indexOf(input.image);

  if (imageIndex < 0) throw new Error("Command runtime image is missing.");

  const configurationFingerprint = createHash("sha256")
    .update(
      JSON.stringify([input.image, input.commandArgs.slice(imageIndex + 1)]),
    )
    .digest("hex");
  const key = JSON.stringify([
    resolve(input.root),
    input.teamId,
    input.integrationId,
  ]);
  const previous = starts.get(key);
  const operation = (async () => {
    await previous?.catch(() => {});
    input.signal.throwIfAborted();

    for (const session of all(input.root)) {
      if (
        session.teamId !== input.teamId ||
        session.integrationId !== input.integrationId ||
        session.result
      )
        continue;

      const result = await readTeamCommand(
        input.root,
        input.teamId,
        session.sessionId,
        input.redact,
      );

      if (result.status === "running" || result.status === "starting") {
        if (
          session.configurationFingerprint !== configurationFingerprint ||
          JSON.stringify(session.args) !== JSON.stringify(input.args)
        )
          throw new ChatToolError(
            `Command session ${session.sessionId} is running. Read or cancel it first.`,
          );

        return { ...result, reused: true };
      }
    }

    const session: Session = {
      sessionId: randomUUID(),
      teamId: input.teamId,
      integrationId: input.integrationId,
      args: input.args,
      configurationFingerprint,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      redactions: Object.values(input.secrets).filter(Boolean),
      launching: true,
    };
    save(input.root, session);
    const args = input.commandArgs
      .slice(0, imageIndex)
      .filter((arg) => arg !== "--rm" && arg !== "--interactive")
      .concat(input.commandArgs.slice(imageIndex));
    args[args.indexOf("--name") + 1] = container(session.sessionId);
    args.splice(
      1,
      0,
      "--log-driver=local",
      "--log-opt=max-size=10m",
      "--log-opt=max-file=2",
    );
    args.splice(
      args.indexOf(input.image) + 1,
      0,
      "/usr/bin/timeout",
      "--signal=TERM",
      "--kill-after=5",
      "1800",
    );

    args[0] = "create";
    const ready = (async () => {
      let phase = "Container creation";

      try {
        // Creation is deliberately separate: a timed-out create must never
        // launch the command later, after its caller has reported failure.
        await exec("docker", args, {
          env: { PATH: process.env.PATH, ...input.secrets },
          timeout: 120000,
        });
        phase = "Container startup";
        await exec("docker", ["start", container(session.sessionId)], {
          timeout: 60000,
        });
        save(input.root, { ...session, launching: false });
      } catch (error) {
        const detail =
          typeof error === "object" &&
          error !== null &&
          "stderr" in error &&
          typeof error.stderr === "string"
            ? input.redact(error.stderr).slice(-4000).trim()
            : "";
        save(input.root, {
          ...session,
          launching: false,
          redactions: [],
          result: {
            status: "failed",
            exitCode: null,
            stdout: "",
            truncated: false,
            stderr: `${phase} failed. ${detail || "Docker did not become ready before the infrastructure deadline. Check Docker availability and load."}`,
          },
        });
        await remove(session.sessionId).catch(() => {});
      }
    })();
    launches.set(session.sessionId, { root: resolve(input.root), ready });
    void ready
      .finally(() => launches.delete(session.sessionId))
      .catch(() => {});

    return readTeamCommand(
      input.root,
      input.teamId,
      session.sessionId,
      input.redact,
      false,
      500,
    );
  })();
  starts.set(key, operation);

  try {
    return await operation;
  } finally {
    if (starts.get(key) === operation) starts.delete(key);
  }
}

export async function closeTeamCommands(
  root: string,
  teamId?: string,
  integrationIds?: readonly string[],
) {
  await Promise.allSettled(
    [...starts.entries()]
      .filter(([key]) => {
        const [dataRoot, sessionTeam, integration] = JSON.parse(key);

        return (
          dataRoot === resolve(root) &&
          (!teamId || sessionTeam === teamId) &&
          !integrationIds?.includes(integration)
        );
      })
      .map(([, operation]) => operation),
  );
  await Promise.allSettled(
    [...launches.values()]
      .filter((launch) => launch.root === resolve(root))
      .map((launch) => launch.ready),
  );
  await Promise.all(
    all(root).map(async (session) => {
      if (session.result) return;
      if (teamId && session.teamId !== teamId) return;
      if (integrationIds?.includes(session.integrationId)) return;

      await remove(session.sessionId);

      if (!session.result)
        save(root, {
          ...session,
          redactions: [],
          result: {
            status: "cancelled",
            exitCode: null,
            stdout: "",
            stderr: "Command stopped by Paws.",
            truncated: false,
          },
        });
    }),
  );
}
