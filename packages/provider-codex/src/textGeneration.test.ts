import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { generateCodexText } from "./textGeneration.ts";

it("isolates ephemeral generation, disables inherited MCP and passes prompts over stdin", async () => {
  await mkdir("/tmp/codex", { recursive: true });
  const root = await mkdtemp("/tmp/codex/paws-text-cli-");
  const script = join(root, "fake-codex.mjs");
  const record = join(root, "record.json");
  await writeFile(
    script,
    `
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args.includes('list')) {
      console.log(JSON.stringify([{name:'private.server', enabled:true}]));
    } else {
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      writeFileSync(process.env.RECORD, JSON.stringify({args, input, cwd:process.cwd()}));
      writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({role:'Reviewer',description:'Reviews APIs.'}));
    }
  `,
  );

  try {
    const text = await generateCodexText(
      {
        command: process.execPath,
        args: [script],
        cwd: root,
        signal: AbortSignal.timeout(5000),
        env: { ...process.env, RECORD: record },
      },
      {
        model: "gpt-6-luna",
        prompt: "untrusted $(text)",
        schema: { type: "object" },
      },
    );
    expect(JSON.parse(text)).toEqual({
      role: "Reviewer",
      description: "Reviews APIs.",
    });
    const captured = JSON.parse(await readFile(record, "utf8"));
    expect(captured.args).toContain("--ephemeral");
    expect(captured.args).toContain(
      'mcp_servers={"private.server"={enabled=false}}',
    );
    expect(captured.args).toContain("read-only");
    expect(captured.input).toBe("untrusted $(text)");
    expect(captured.cwd).not.toBe(root);
    await expect(readFile(join(captured.cwd, "result.json"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
