import { Node, type Editor } from "@tiptap/core";
import type { AgentSkill } from "@paws/contracts";

// T3 Code's skill nodes keep a human-readable chip but serialize as $name.
export function skillExtension(skills: () => readonly AgentSkill[]) {
  return Node.create({
    name: "skill",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addAttributes: () => ({
      name: { default: "" },
      description: { default: "" },
    }),
    parseHTML: () => [{ tag: "span[data-skill]" }],
    renderHTML: ({ node }) => [
      "span",
      {
        "data-skill": node.attrs.name,
        class: "composer-skill-chip",
        title: node.attrs.description,
      },
      `$${node.attrs.name}`,
    ],
    renderText: ({ node }) => `$${node.attrs.name}`,
    renderMarkdown: (node) => `$${node.attrs?.name ?? ""}`,
    markdownTokenizer: {
      name: "skill",
      level: "inline",
      start: "$",
      tokenize: (source) => {
        const match = /^\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|[.,!?;)]|$)/.exec(
          source,
        );
        const skill = skills().find((item) => item.name === match?.[1]);

        if (!match || !skill) return;

        return {
          type: "skill",
          raw: match[0],
          name: skill.name,
          description: skill.description,
        };
      },
    },
    parseMarkdown: (token) => ({
      type: "skill",
      attrs: { name: token.name, description: token.description },
    }),
  });
}

export function searchSkills(skills: readonly AgentSkill[], query: string) {
  const normalized = query.toLowerCase();

  return skills
    .filter((skill) =>
      `${skill.name} ${skill.description}`.toLowerCase().includes(normalized),
    )
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(normalized)) -
          Number(a.name.toLowerCase().startsWith(normalized)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 30);
}

// Resolve saved drafts after the asynchronous catalog arrives without resetting
// selection, formatting, or the editor's undo history.
export function restoreSkillChips(
  editor: Editor,
  skills: readonly AgentSkill[],
) {
  const replacements: Array<{ from: number; to: number; skill: AgentSkill }> =
    [];
  editor.state.doc.descendants((node, position, parent) => {
    if (
      !node.isText ||
      parent?.type.name === "codeBlock" ||
      node.marks.some((mark) => mark.type.name === "code")
    )
      return;

    for (const match of node.text!.matchAll(
      /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|[.,!?;)]|$)/g,
    )) {
      const skill = skills.find((candidate) => candidate.name === match[2]);

      if (skill)
        replacements.push({
          from: position + match.index + match[1]!.length,
          to: position + match.index + match[0].length,
          skill,
        });
    }
  });

  if (!replacements.length) return;

  const transaction = editor.state.tr.setMeta("addToHistory", false);

  for (const { from, to, skill } of replacements.reverse()) {
    transaction.replaceWith(
      from,
      to,
      editor.schema.nodes.skill!.create({
        name: skill.name,
        description: skill.description,
      }),
    );
  }

  editor.view.dispatch(transaction);
}
