import { spawn } from "node:child_process";

const [distribution, ...args] = process.argv.slice(2);

if (!distribution || !/^Paws-[a-f0-9]{16}$/.test(distribution))
  throw new Error("Invalid Paws distribution.");

// WSLENV transfers selected variables without putting secret values in argv.
const names = args.flatMap((argument, index) =>
  args[index - 1] === "--env" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(argument)
    ? [`${argument}/u`]
    : [],
);
const child = spawn(
  "wsl.exe",
  [
    "--distribution",
    distribution,
    "--user",
    "root",
    "--exec",
    "/usr/local/bin/docker",
    "--host",
    "unix:///var/run/docker.sock",
    "--config",
    "/root/.docker",
    ...args,
  ],
  {
    env: { ...process.env, WSLENV: names.join(":") },
    stdio: "inherit",
    windowsHide: true,
  },
);
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
