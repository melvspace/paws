import * as Fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { callCodexMcp, authenticateCodexMcp } from "./mcp.ts";

it("uses native MCP inventory and calls without starting a model turn", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-native-mcp-");
  const fixture = join(root, "rpc.mjs");
  await Fs.writeFile(
    fixture,
    `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 appendFileSync(${JSON.stringify(join(root, "calls"))},m.method+'\\n');
 const result=m.method==='mcpServerStatus/list'?{data:[{name:'shared',authStatus:process.env.AUTH_STATUS??'oAuth',toolsError:process.env.AUTH_STATUS?'MCP startup failed: Auth required, when send initialize request':null,tools:{identity:{name:'identity',inputSchema:{type:'object'}}}}]}:
 m.method==='thread/start'?{thread:{id:'native-thread'}}:
 m.method==='mcpServer/tool/call'?{content:[{type:'text',text:'Team user'}]}:{};
 console.log(JSON.stringify({id:m.id,result}));
});`,
  );
  const launch = {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    signal: AbortSignal.timeout(5000),
  };

  try {
    expect(await callCodexMcp(launch, { action: "tools" })).toMatchObject({
      tools: [{ name: "identity" }],
    });
    expect(
      await callCodexMcp(launch, { action: "call", tool: "identity" }),
    ).toMatchObject({ content: [{ text: "Team user" }] });
    for (const status of ["unknown", "notLoggedIn"]) {
      expect(
        await callCodexMcp(
          { ...launch, env: { ...process.env, AUTH_STATUS: status } },
          { action: "tools" },
        ),
      ).toEqual({ status: "authentication_required" });
    }

    const calls = await Fs.readFile(join(root, "calls"), "utf8");
    expect(calls).toContain("mcpServer/tool/call");
    expect(calls).not.toContain("turn/start");
    expect(calls).not.toContain("account/login");
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("keeps native no-browser login alive for a private callback and rejects failed login", async () => {
  const root = await Fs.mkdtemp("/tmp/codex/paws-native-login-");
  const fixture = join(root, "login.mjs");
  await Fs.writeFile(
    fixture,
    `
import readline from 'node:readline';
console.log('Authorize the MCP server by opening this URL in your browser:');
console.log('https://service.test/authorize?state=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback');
readline.createInterface({input:process.stdin}).once('line', line=>{
 process.exit(new URL(line).searchParams.get('code')==='approved'?0:1);
});`,
  );
  const launch = {
    command: process.execPath,
    args: [fixture],
    cwd: root,
    signal: AbortSignal.timeout(5000),
  };

  try {
    const callback = Promise.withResolvers<string>();
    const url = Promise.withResolvers<string>();
    const login = authenticateCodexMcp(launch, url.resolve, callback.promise);
    expect(await url.promise).toContain("https://service.test/authorize");
    callback.resolve("http://127.0.0.1/callback?state=fixture&code=approved");
    await login;
    await expect(
      authenticateCodexMcp(
        launch,
        () => {},
        Promise.resolve("http://127.0.0.1/callback?code=declined"),
      ),
    ).rejects.toThrow("sign-in failed");
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});
