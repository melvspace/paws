import * as Fs from "node:fs";
import * as Path from "node:path";
import { providerDriver } from "@paws/provider-core";
import type { ProviderDriver } from "@paws/contracts";

// Inspect PATH without starting providers or triggering native setup/authentication.
export function isProviderInstalled(driver: ProviderDriver): boolean {
  const command = providerDriver(driver).command;

  if (!command) return false;

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];

  return (process.env.PATH ?? "").split(Path.delimiter).some((directory) =>
    extensions.some((extension) => {
      const candidate = Path.join(directory, `${command}${extension}`);

      try {
        Fs.accessSync(candidate, Fs.constants.X_OK);

        return Fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }),
  );
}
