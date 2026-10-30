import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

const MAX_OUTPUT = 4 * 1024 * 1024;

export class ProbeError extends Error {
  readonly kind: "missing" | "timeout" | "protocol" | "exit";

  constructor(kind: ProbeError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

async function terminate(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) return;

  function kill(signal: NodeJS.Signals) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid!, signal);
      else child.kill(signal);
    } catch {
      // The process group may already have exited.
    }
  }

  const exited = child.exitCode !== null || child.signalCode !== null;
  const closed = exited
    ? Promise.resolve()
    : once(child, "close").catch(() => {});
  kill("SIGTERM");
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 200)),
  ]);
  kill("SIGKILL");
}

export interface ProbeLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

// One owner per probe. Never open an agent session or send a user prompt here.
export async function withProcess<T>(
  launch: ProbeLaunch,
  use: (
    child: ChildProcessWithoutNullStreams,
    fail: Promise<never>,
  ) => Promise<T>,
): Promise<T> {
  launch.signal.throwIfAborted();
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env ?? process.env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: "pipe",
    windowsHide: true,
  });
  let rejectFailure: (error: Error) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const abort = () =>
    rejectFailure(
      new ProbeError("timeout", "Provider check cancelled or timed out."),
    );
  child.on("error", (error: NodeJS.ErrnoException) =>
    rejectFailure(
      new ProbeError(
        error.code === "ENOENT" ? "missing" : "exit",
        "Could not start provider executable.",
      ),
    ),
  );
  child.stdin.on("error", () =>
    rejectFailure(new ProbeError("exit", "Provider closed its input.")),
  );
  child.stderr.resume(); // Never return native stderr: it can contain credentials.
  launch.signal.addEventListener("abort", abort, { once: true });

  try {
    return await Promise.race([use(child, failure), failure]);
  } finally {
    launch.signal.removeEventListener("abort", abort);
    await terminate(child);
  }
}

export async function runCommand(launch: ProbeLaunch): Promise<string> {
  return withProcess(
    launch,
    (child) =>
      new Promise((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          output += text;

          if (Buffer.byteLength(output) > MAX_OUTPUT) {
            reject(
              new ProbeError(
                "protocol",
                "Provider response exceeded the size limit.",
              ),
            );
          }
        });
        child.on("close", (code) => {
          if (code !== 0)
            reject(
              new ProbeError(
                "exit",
                "Provider command failed. Check its CLI setup.",
              ),
            );
          else resolve(output);
        });
      }),
  );
}

export interface JsonRpc {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  onNotification(
    handler: (method: string, params: unknown) => void,
  ): () => void;
}

export async function withJsonRpc<T>(
  launch: ProbeLaunch,
  use: (rpc: JsonRpc) => Promise<T>,
  protocol: "jsonrpc" | "pi" = "jsonrpc",
): Promise<T> {
  return withProcess(launch, async (child, failure) => {
    const closed = new Promise<never>((_resolve, reject) => {
      child.once("close", () =>
        reject(new ProbeError("exit", "Provider exited during discovery.")),
      );
    });
    const ioFailure = Promise.race([failure, closed]);
    const listeners = new Set<(method: string, params: unknown) => void>();
    let counter = 0;
    let buffer = "";
    const pending = new Map<
      string,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const send = (value: unknown) =>
      child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      buffer += text;

      if (Buffer.byteLength(buffer) > MAX_OUTPUT) {
        for (const request of pending.values())
          request.reject(
            new ProbeError(
              "protocol",
              "Provider response exceeded the size limit.",
            ),
          );
        buffer = "";

        return;
      }

      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let message: Record<string, unknown>;

        try {
          const parsed: unknown = JSON.parse(line);

          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            continue;
          message = parsed as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.method && message.id !== undefined) {
          send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message:
                "Read-only catalog probe: client operations unavailable.",
            },
          });

          continue;
        }

        if (typeof message.method === "string" && message.id === undefined) {
          for (const listener of listeners)
            listener(message.method, message.params);

          continue;
        }

        const request = pending.get(String(message.id));

        if (!request) continue;
        pending.delete(String(message.id));

        if (message.error || message.success === false) {
          request.reject(
            new ProbeError(
              "protocol",
              "Provider rejected catalog discovery. Check authentication and CLI version.",
            ),
          );
        } else {
          request.resolve(protocol === "pi" ? message.data : message.result);
        }
      }
    });
    child.on("close", () => {
      for (const request of pending.values())
        request.reject(
          new ProbeError("exit", "Provider exited during discovery."),
        );
    });

    return Promise.race([
      use({
        onNotification(handler) {
          listeners.add(handler);

          return () => {
            listeners.delete(handler);
          };
        },
        request(method, params = {}) {
          const id = String(++counter);
          const response = new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send(
              protocol === "pi"
                ? { id, type: method, ...params }
                : { jsonrpc: "2.0", id, method, params },
            );
          });

          return Promise.race([response, ioFailure]);
        },
        notify(method, params = {}) {
          send({ jsonrpc: "2.0", method, params });
        },
      }),
      ioFailure,
    ]);
  });
}
