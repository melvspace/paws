import { randomUUID } from "node:crypto";
import {
  getContainerEngine,
  prepareRuntimeImage,
  RuntimeSetupError,
  ContainerRuntimeError,
} from "@paws/runtime";

export async function initializeRuntime(
  root: string,
  options: {
    prepare?: typeof getContainerEngine;
    authorize?: (error: RuntimeSetupError) => Promise<void>;
  } = {},
) {
  const prepare = options.prepare ?? getContainerEngine;

  async function check() {
    const engine = await prepare(root);
    await engine.execute(["info"], { timeout: 10_000 });
    await prepareRuntimeImage(engine);
    const probe = `paws-startup-${randomUUID()}`;

    try {
      await engine.execute(
        [
          "run",
          "--rm",
          "--name",
          probe,
          "--label",
          "app=paws-startup",
          "--memory=32m",
          "--cpus=0.1",
          "--pids-limit=16",
          "paws-team-runtime:1",
          "/bin/true",
        ],
        { timeout: 30_000 },
      );
    } catch (error) {
      throw new ContainerRuntimeError(
        "Paws could not start its sandbox. The runtime failed its startup check.",
        { cause: error },
      );
    } finally {
      await engine
        .execute(["rm", "--force", probe], { timeout: 10_000 })
        .catch(() => {});
    }
  }

  try {
    await check();
  } catch (error) {
    if (!(error instanceof RuntimeSetupError) || !options.authorize)
      throw error;

    await options.authorize(error);
    await check();
  }
}

export function desktopRuntimeAuthorization(error: RuntimeSetupError) {
  if (process.env.PAWS_DESKTOP !== "1" || !process.connected || !process.send)
    return Promise.reject(error);

  return new Promise<void>((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", receive);
      process.off("disconnect", disconnect);
    };
    const disconnect = () => {
      cleanup();
      reject(new Error("Paws closed during runtime setup."));
    };
    const receive = (message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("type" in message) ||
        message.type !== "runtime-setup-finished" ||
        !("id" in message) ||
        message.id !== id
      )
        return;

      cleanup();

      if ("ok" in message && message.ok === true) resolve();
      else
        reject(
          new ContainerRuntimeError(
            "Paws setup was not completed. Start Paws again to retry setup.",
          ),
        );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Paws runtime setup timed out."));
    }, 300_000);
    process.on("message", receive);
    process.once("disconnect", disconnect);
    process.send!({
      type: "runtime-setup-required",
      id,
      helper: error.helper,
      binary: error.binary,
    });
  });
}
