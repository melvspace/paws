import * as Fs from "node:fs";
import * as Path from "node:path";
import { parseDocument } from "yaml";
import { Schema } from "effect";
import type { AgentSkill } from "@paws/contracts";
import { workspaceLayout } from "@paws/runtime";

const metadata = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  "user-invocable": Schema.optional(Schema.Boolean),
});

// Workspace skills take precedence over home skills, independent of provider.
export function listAgentSkills(root: string, agentId: string): AgentSkill[] {
  const layout = workspaceLayout(root, agentId);
  const skills = new Map<string, AgentSkill>();
  let visited = 0;

  function visit(directory: string, mount: string, virtual: string, depth = 0) {
    if (depth > 5 || visited++ >= 1000) return;

    try {
      const real = Fs.realpathSync(directory);
      const relative = Path.relative(mount, real);

      if (relative.startsWith("..") || Path.isAbsolute(relative)) return;
      if (!Fs.lstatSync(directory).isDirectory()) return;

      const file = Path.join(directory, "SKILL.md");

      if (Fs.existsSync(file)) {
        const descriptor = Fs.openSync(
          file,
          Fs.constants.O_RDONLY |
            Fs.constants.O_NOFOLLOW |
            Fs.constants.O_NONBLOCK,
        );

        try {
          const stat = Fs.fstatSync(descriptor);

          if (stat.isFile() && stat.size <= 65536) {
            const source = Fs.readFileSync(descriptor, "utf8");
            const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
              source,
            );

            if (frontmatter) {
              const document = parseDocument(frontmatter[1]!, {
                uniqueKeys: true,
              });

              if (document.errors.length) return;

              const value = Schema.decodeUnknownSync(metadata)(
                document.toJS({ maxAliasCount: 0 }),
              );

              if (
                /^[a-zA-Z][a-zA-Z0-9:_-]{0,99}$/.test(value.name) &&
                value["user-invocable"] !== false &&
                !skills.has(value.name)
              ) {
                skills.set(value.name, {
                  name: value.name,
                  description: (value.description ?? "").trim().slice(0, 1000),
                  path: `${virtual}/SKILL.md`,
                });
              }
            }
          }
        } finally {
          Fs.closeSync(descriptor);
        }
      }

      for (const entry of Fs.readdirSync(directory, {
        withFileTypes: true,
      }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          visit(
            Path.join(directory, entry.name),
            mount,
            `${virtual}/${entry.name}`,
            depth + 1,
          );
        }
      }
    } catch {
      // Missing, malformed, oversized or linked skills are not invocable.
    }
  }

  for (const [host, virtual] of [
    [layout.workspace, "/workspace"],
    [layout.home, "/home/agent"],
  ]) {
    for (const folder of [
      ".agents/skills",
      ".claude/skills",
      ".codex/skills",
    ]) {
      visit(Path.join(host!, folder), host!, `${virtual}/${folder}`);
    }
  }

  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function withSkillContext(text: string, skills: readonly AgentSkill[]) {
  // Literal examples and code are not skill invocations.
  const prose = text.replace(
    /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+/g,
    "",
  );
  const names = new Set(
    [
      ...prose.matchAll(
        /(?:^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|[.,!?;)]|$)/g,
      ),
    ].map((match) => match[1]),
  );
  const selected = skills.filter((skill) => names.has(skill.name));

  if (!selected.length) return text;

  return `${text}\n\n[Paws skill selections]\nThe user invoked these installed skills. Read each SKILL.md using your execution tool before doing the task, and follow its instructions. Paths are inside your agent runtime. Resolve referenced files relative to the skill directory.\n${JSON.stringify(selected.map(({ name, path }) => ({ name, path })))}\n[/Paws skill selections]`;
}
