import { createHash } from "node:crypto";

export function wslDistribution(root: string) {
  return `Paws-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`;
}

export function wslPath(path: string) {
  const drive = /^([a-z]):[\\/](.*)$/i.exec(path);

  if (!drive)
    throw new Error("Paws runtime files must be on a local Windows drive.");

  return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}`;
}

export function wslArguments(args: string[]) {
  // Only host filesystem arguments cross this boundary. Container commands,
  // scripts and container-local paths must retain their exact bytes.
  const operation = args[0];

  return args.map((argument, index) => {
    if (operation === "create" && args[index - 1] === "--mount")
      return argument.replace(
        /src=([A-Za-z]:[\\/][^,]*)/,
        (_match, path: string) => `src=${wslPath(path)}`,
      );
    if (
      (operation === "cp" || operation === "build") &&
      /^[a-z]:[\\/]/i.test(argument)
    )
      return wslPath(argument);

    return argument;
  });
}
