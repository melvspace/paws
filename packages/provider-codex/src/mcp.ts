import { Schema } from "effect";
import { ChatToolError } from "@paws/provider-core";
import {
  withJsonRpc,
  withProcess,
  type ProbeLaunch,
} from "@paws/provider-core/process";

const Status = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      authStatus: Schema.String,
      toolsError: Schema.NullOr(Schema.String),
      tools: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
});

export async function callCodexMcp(
  launch: ProbeLaunch,
  input: {
    action: "tools" | "call";
    tool?: string | undefined;
    arguments?: Readonly<Record<string, unknown>> | undefined;
  },
  cwd = "/workspace",
) {
  return withJsonRpc(launch, async (rpc) => {
    await rpc.request("initialize", {
      clientInfo: { name: "paws", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    const status = Schema.decodeUnknownSync(Status)(
      await rpc.request("mcpServerStatus/list", { serverName: "shared" }),
    ).data.find((item) => item.name === "shared");

    if (!status)
      throw new ChatToolError(
        "The harness did not load the team MCP connection.",
      );
    if (
      status.toolsError &&
      (status.authStatus === "notLoggedIn" ||
        /\bAuth(?:entication)? required\b|\bHTTP 401\b/i.test(
          status.toolsError,
        ))
    )
      return { status: "authentication_required" };
    if (status.toolsError)
      throw new ChatToolError(
        "The harness could not connect to the MCP server. Check its URL, network access, and authentication.",
      );
    if (input.action === "tools") return { tools: Object.values(status.tools) };

    const started = Schema.decodeUnknownSync(
      Schema.Struct({
        thread: Schema.Struct({ id: Schema.String }),
      }),
    )(
      await rpc.request("thread/start", {
        cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
      }),
    );

    // No model turn or general-purpose execution is started by this helper.
    return rpc.request("mcpServer/tool/call", {
      threadId: started.thread.id,
      server: "shared",
      tool: input.tool,
      arguments: input.arguments ?? {},
    });
  });
}

export async function authenticateCodexMcp(
  launch: ProbeLaunch,
  onAuthorization: (url: string) => void,
  callback: Promise<string>,
) {
  await withProcess(launch, async (child, failure) => {
    let output = "";
    let announced = false;
    const completed = new Promise<void>((resolve, reject) => {
      child.once("close", (code) =>
        code === 0 && announced
          ? resolve()
          : reject(
              new ChatToolError(
                "Codex MCP sign-in failed. Retry sign-in and provide the complete callback URL.",
              ),
            ),
      );
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output = (output + chunk).slice(-16384);

      if (announced) return;

      const candidate = output
        .split(/\r?\n/)
        .slice(0, -1)
        .find((line) => /^https?:\/\/\S+$/.test(line.trim()));

      if (!candidate) return;

      const url = new URL(candidate.trim());

      if (
        !url.searchParams.has("state") ||
        !url.searchParams.has("redirect_uri")
      )
        return;

      announced = true;
      onAuthorization(url.href);
    });
    const input = callback.then((url) => {
      // CLI --no-browser validates the full callback, state, PKCE, and issuer.
      child.stdin.end(`${url}\n`);
    });
    await Promise.race([Promise.all([input, completed]), failure]);
  });
}
