import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { makeAgentService } from "./AgentService.ts";
import { teamTool } from "./teamIntegrations.ts";

it("preserves absolute and relative shared MCP commands and one file-backed login across members and restarts", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-local-mcp-");
  const previousPath = process.env.PATH;
  let service = makeAgentService(root);

  try {
    const team = (await Effect.runPromise(
      service.saveTeam({
        name: "Legacy",
        memory: "",
        integrations: [
          {
            id: "local",
            kind: "mcp-stdio",
            command: "node",
            args: ["/workspace/server.mjs"],
          },
        ],
      }),
    ))!;
    const first = await Effect.runPromise(
      service.create({ name: "A", teamId: team.id }),
    );
    const second = await Effect.runPromise(
      service.create({ name: "B", teamId: team.id }),
    );
    const shared = join(root, "teams", team.id, "files");
    const auth = join(root, "team-auth", team.id, "local", "home");
    await Fs.mkdir(auth, { recursive: true });
    await Fs.writeFile(join(auth, ".login"), "legacy-login");
    await Fs.writeFile(join(shared, "shared.txt"), "shared-work");
    await Fs.writeFile(
      join(shared, "server.mjs"),
      `
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
 const request = JSON.parse(line);
 if (request.id === undefined) continue;
 let result;
 if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: {tools:{}}, serverInfo: {name:'shared',version:'1'} };
 else if (request.method === 'tools/list') result = {tools:[{name:'identity',inputSchema:{type:'object'}}]};
 else {
  result = {content:[{type:'text',text:readFileSync(process.env.HOME+'/.login','utf8')+'|'+readFileSync('shared.txt','utf8')}]};
  writeFileSync(process.env.HOME+'/.login','refreshed-login');
 }
 console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
}
`,
    );
    // Model Docker's filesystem/exec boundary, while using the real MCP SDK and
    // stdio subprocess. Every container and HOME maps into this isolated root.
    await Fs.writeFile(
      join(root, "docker"),
      `#!${process.execPath}
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
const root = ${JSON.stringify(root)};
const shared = ${JSON.stringify(shared)};
const args = process.argv.slice(2);
const containerRoot = path.join(root,'container');
const map = (value) => value === '/team/files' || value.startsWith('/workspace/')
 ? path.join(shared, value === '/team/files' ? '' : value.slice('/workspace/'.length))
 : path.join(containerRoot,value);
fs.appendFileSync(path.join(root,'calls'),JSON.stringify(args)+'\\n');
if(args[0] === 'container') {
 if (!fs.existsSync(containerRoot)) { console.error('No such container'); process.exit(1); }
} else if(args[0] === 'create') fs.mkdirSync(containerRoot);
else if(args[0] === 'cp') {
 const destination = map(args[2].slice(args[2].indexOf(':')+1));
 if(fs.existsSync(path.join(root,'fail-copy'))) { fs.writeFileSync(path.join(destination,'partial'),'partial'); process.exit(1); }
 fs.cpSync(args[1],destination,{recursive:true});
} else if(args[0] === 'exec') {
 if(args.includes('paws-runtime')) {
  const marker = args.indexOf('paws-runtime');
  const commandArgs = args.slice(marker+2);
  const env = {...process.env};
  for(let i=0;i<marker;i++) if(args[i] === '--env' && args[i+1].includes('=')) {
   const [name,...value] = args[i+1].split('=');
   env[name] = map(value.join('='));
  }
  const child = spawn(commandArgs[0],commandArgs.slice(1).map((arg)=>arg.startsWith('/workspace/') ? map(arg) : arg),{
   cwd:map(args[args.indexOf('--workdir')+1]),env,stdio:'inherit',
  });
  child.on('exit',(code)=>process.exit(code ?? 1));
 } else if(args[2] === 'test') process.exit(fs.existsSync(map(args.at(-1))) ? 0 : 1);
 else if(args[2] === 'mkdir') fs.mkdirSync(map(args.at(-1)),{recursive:true});
 else if(args.includes('paws-integration')) {
  const i = args.indexOf('paws-integration');
  fs.mkdirSync(path.dirname(map(args[i+2])),{recursive:true});
  fs.renameSync(map(args[i+1]),map(args[i+2]));
 } else if(args[2] === 'rm') fs.rmSync(map(args.at(-1)),{recursive:true,force:true});
}
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    const call = (id: string) =>
      teamTool(
        root,
        id,
        {
          teamId: team.id,
          integrationId: "local",
          action: "call",
          tool: "identity",
        },
        new AbortController().signal,
      );
    await Fs.writeFile(join(root, "fail-copy"), "fail");
    await expect(call(first.id)).rejects.toThrow("MCP operation failed");
    expect(await Fs.readdir(join(root, "container", "tmp"))).toEqual([]);
    await Fs.rm(join(root, "fail-copy"));
    expect(await call(first.id)).toMatchObject({
      content: [{ text: "legacy-login|shared-work" }],
    });
    service.close();
    service = makeAgentService(root);
    await Effect.runPromise(
      service.saveTeam(
        {
          integrations: [
            {
              id: "local",
              kind: "mcp-stdio",
              command: "node",
              args: ["server.mjs"],
            },
          ],
        },
        team.id,
      ),
    );
    expect(await call(second.id)).toMatchObject({
      content: [{ text: "refreshed-login|shared-work" }],
    });
    expect(await call(first.id)).toMatchObject({
      content: [{ text: "refreshed-login|shared-work" }],
    });
    expect(await Fs.readFile(join(auth, ".login"), "utf8")).toBe(
      "legacy-login",
    );
    const calls: string[][] = (await Fs.readFile(join(root, "calls"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter(([operation]) => operation === "cp")).toHaveLength(2);
    expect(
      calls
        .filter(([operation]) => operation === "create")
        .flat()
        .join(" "),
    ).not.toContain("team-auth");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;

    service.close();
    await Fs.rm(root, { recursive: true, force: true });
  }
});
