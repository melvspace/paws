import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { assertAgentId } from "@paws/shared";

const exec = promisify(execFile);
const starts = new Map<string, Promise<unknown>>();
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
  createdAt: Schema.String,
  expiresAt: Schema.String,
  redactions: Schema.optional(Schema.Array(Schema.String)),
  result: Schema.optional(Result),
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
    .map(({ sessionId, integrationId, createdAt, expiresAt, result }) => ({
      sessionId,
      integrationId,
      createdAt,
      expiresAt,
      status: result?.status ?? "running",
    }));
}

export function commandIntegration(root: string, teamId: string, id: string) {
  const session = load(root, id);

  if (session.teamId !== teamId)
    throw new Error("Command session belongs to another team.");

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
    const child = spawn("docker", ["logs", "--tail", "200", container(id)], {
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
      else if (code !== 0) reject(new Error("Cannot read command output."));
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
) {
  commandIntegration(root, teamId, id);
  const session = load(root, id);
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
        throw new Error(
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

      if (result.status === "running") {
        if (JSON.stringify(session.args) !== JSON.stringify(input.args))
          throw new Error(
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
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      redactions: Object.values(input.secrets).filter(Boolean),
    };
    save(input.root, session);
    const imageIndex = input.commandArgs.indexOf(input.image);
    const args = input.commandArgs
      .slice(0, imageIndex)
      .filter((arg) => arg !== "--rm" && arg !== "--interactive")
      .concat(input.commandArgs.slice(imageIndex));
    args[args.indexOf("--name") + 1] = container(session.sessionId);
    args.splice(
      1,
      0,
      "--detach",
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

    try {
      await exec("docker", args, {
        env: { PATH: process.env.PATH, ...input.secrets },
        signal: input.signal,
        timeout: 30000,
      });
    } catch (error) {
      await remove(session.sessionId).catch(() => {});
      Fs.rmSync(join(directory(input.root), `${session.sessionId}.json`), {
        force: true,
      });

      const diagnostic =
        typeof error === "object" &&
        error !== null &&
        "stderr" in error &&
        typeof error.stderr === "string"
          ? input.redact(error.stderr.slice(-4000))
          : input.signal.aborted
            ? "Start was cancelled."
            : "Check Docker availability.";

      throw new Error(`Could not start command session. ${diagnostic}`);
    }

    return readTeamCommand(
      input.root,
      input.teamId,
      session.sessionId,
      input.redact,
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
