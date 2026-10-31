import * as Fs from "node:fs/promises";
import * as Path from "node:path";
import { expect, it } from "vite-plus/test";
import { provisionWorkspace } from "@paws/runtime";
import { listAgentSkills, withSkillContext } from "./agentSkills.ts";

it("discovers agent-owned skills, honors precedence and metadata, and excludes unsafe files", async () => {
  await Fs.mkdir("/tmp/codex", { recursive: true });
  const root = await Fs.mkdtemp("/tmp/codex/paws-skills-");

  try {
    const layout = await provisionWorkspace(
      root,
      "11111111-1111-4111-8111-111111111111",
    );
    const install = async (directory: string, content: string) => {
      await Fs.mkdir(directory, { recursive: true });
      await Fs.writeFile(Path.join(directory, "SKILL.md"), content);
    };
    await install(
      Path.join(layout.skills, "writer"),
      "---\nname: writer\ndescription: Home writer\n---\nBody",
    );
    await install(
      Path.join(layout.workspace, ".agents/skills/writer"),
      "---\nname: writer\ndescription: >-\n  Write clear\n  prose.\n---\nBody",
    );
    await install(
      Path.join(layout.home, ".claude/skills/review"),
      "---\nname: review\ndescription: Review code\n---\nBody",
    );
    await install(
      Path.join(layout.skills, "internal"),
      "---\nname: internal\nuser-invocable: false\n---\nBody",
    );
    await install(
      Path.join(layout.skills, "invalid"),
      "---\nname: [invalid]\n---\nBody",
    );
    await install(Path.join(layout.skills, "huge"), "x".repeat(65537));
    await install(
      Path.join(root, "outside"),
      "---\nname: outside\n---\nNot mounted",
    );
    await Fs.symlink(
      Path.join(root, "outside"),
      Path.join(layout.skills, "linked"),
    );
    await Fs.mkdir(Path.join(layout.skills, "linked-file"));
    await Fs.symlink(
      Path.join(root, "outside/SKILL.md"),
      Path.join(layout.skills, "linked-file/SKILL.md"),
    );
    const skills = listAgentSkills(
      root,
      "11111111-1111-4111-8111-111111111111",
    );
    expect(skills.map((skill) => skill.name)).toEqual(["review", "writer"]);
    expect(skills[1]).toEqual({
      name: "writer",
      description: "Write clear prose.",
      path: "/workspace/.agents/skills/writer/SKILL.md",
    });
    expect(JSON.stringify(skills)).not.toContain(root);
    expect(
      listAgentSkills(root, "22222222-2222-4222-8222-222222222222"),
    ).toEqual([]);
    expect(() => listAgentSkills(root, "../escape")).toThrow();
  } finally {
    await Fs.rm(root, { recursive: true, force: true });
  }
});

it("resolves explicit installed skill mentions without interpreting code, prices, or unknown tokens", () => {
  const skills = [
    {
      name: "writer",
      description: "Write",
      path: "/home/agent/.agents/skills/writer/SKILL.md",
    },
  ];
  expect(withSkillContext("Use $writer, please", skills)).toContain(
    skills[0]!.path,
  );
  expect(
    withSkillContext("Use $writer twice: $writer", skills).match(/SKILL.md"/g),
  ).toHaveLength(1);

  for (const text of [
    "$500",
    "email$writer",
    "\\$writer",
    "`$writer`",
    "```\n$writer\n```",
    "$unknown",
    "$writer-extra",
  ]) {
    expect(withSkillContext(text, skills)).toBe(text);
  }
});
