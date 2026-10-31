import { probeOpenCodeProtocol } from "./openCodeProtocol.ts";
import { randomBytes } from "node:crypto";
import { OpenCode } from "@opencode/client";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { withProcess, type ProbeLaunch } from "@paws/provider-core/process";
import { selectOption } from "@paws/provider-core";
import type { ProviderModel } from "@paws/contracts";

// T3 uses a temporary, password-protected loopback helper for inventory discovery.
export async function discoverOpenCode(launch: ProbeLaunch) {
  const password = randomBytes(24).toString("hex");
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  };

  return withProcess(
    {
      ...launch,
      args: [...launch.args, "serve", "--hostname=127.0.0.1", "--port=0"],
      env: {
        ...(launch.env ?? process.env),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_PASSWORD: password,
      },
    },
    async (child, failure) => {
      const ready = new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (text: string) => {
          output = (output + text).slice(-65536);
          const match =
            /server listening on\s+(http:\/\/127\.0\.0\.1:\d+)/i.exec(output);

          if (match) resolve(match[1]!);
        });
        child.on("close", () => reject(new Error("OpenCode helper exited.")));
      });
      const baseUrl = await Promise.race([ready, failure]);
      const protocol = await probeOpenCodeProtocol(
        baseUrl,
        headers,
        launch.signal,
      );
      let models: ProviderModel[];

      if (protocol.generation === "v2") {
        const client = OpenCode.make({ baseUrl, headers });
        const catalog = await client.model.list(
          { location: { directory: launch.cwd } },
          { signal: launch.signal },
        );
        models = catalog.data
          .filter((model) => model.status !== "deprecated")
          .map((model) => ({
            id: `${model.providerID}/${model.id}`,
            name: model.name,
            options: model.variants.length
              ? [
                  selectOption(
                    "variant",
                    "Reasoning",
                    model.variants.map((variant) => variant.id),
                  ),
                ]
              : [],
          }));
      } else {
        const client = createOpencodeClient({
          baseUrl,
          headers,
          directory: launch.cwd,
        });
        const result = await client.provider.list(
          { directory: launch.cwd },
          { signal: launch.signal, throwOnError: true },
        );
        const catalog = result.data!;
        models = catalog.all
          .filter((provider) => catalog.connected.includes(provider.id))
          .flatMap((provider) =>
            Object.values(provider.models)
              .filter((model) => model.status !== "deprecated")
              .map((model) => {
                const variants = Object.keys(model.variants ?? {});

                return {
                  id: `${provider.id}/${model.id}`,
                  name: model.name,
                  options: variants.length
                    ? [selectOption("variant", "Reasoning", variants)]
                    : [],
                };
              }),
          );
      }

      return { auth: "unknown" as const, models, version: protocol.version };
    },
  );
}
