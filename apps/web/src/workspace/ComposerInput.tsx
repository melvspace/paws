import type { ChatAttachment } from "@paws/contracts";
import { ChatImage } from "./ChatImage.tsx";
// Adapted from T3 Code's Tiptap composer, skill chips and trigger picker (MIT).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { PaperclipIcon, FileIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import {
  skillExtension,
  searchSkills,
  restoreSkillChips,
} from "./composerSkills.ts";
import { useAgentSkills } from "./useAgentSkills.ts";
import "./composer-input.css";

export interface ComposerCommand {
  name: string;
  description: string;
  run: () => void;
}

type Trigger = {
  kind: "skill" | "command";
  query: string;
  from: number;
  to: number;
};

function triggerKey(trigger: Trigger) {
  return `${trigger.kind}:${trigger.from}:${trigger.query}`;
}

function detectTrigger(editor: Editor): Trigger | null {
  const { selection } = editor.state;

  if (
    !selection.empty ||
    editor.isActive("code") ||
    editor.isActive("codeBlock")
  )
    return null;

  const before = selection.$from.parent.textBetween(
    0,
    selection.$from.parentOffset,
    "\n",
    "\ufffc",
  );
  const match = /(?:^|\s)([$/])([a-zA-Z0-9:_-]*)$/.exec(before);

  if (!match) return null;

  return {
    kind: match[1] === "$" ? "skill" : "command",
    query: match[2]!,
    from: selection.from - match[2]!.length - 1,
    to: selection.from,
  };
}

export function ComposerInput({
  agentId,
  label,
  value,
  onChange,
  onSend,
  children,
  attachments = [],
  uploading = false,
  attachmentError = null,
  onAttach,
  onRemoveAttachment,
  commands = [],
}: {
  agentId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSend: (alternate: boolean) => void;
  children: ReactNode;
  attachments?: readonly ChatAttachment[];
  uploading?: boolean;
  attachmentError?: string | null;
  onAttach?: (files: readonly File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  commands?: readonly ComposerCommand[];
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const catalog = useAgentSkills(agentId);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [selected, setSelected] = useState(0);
  const [limitReached, setLimitReached] = useState(false);
  const dismissed = useRef<string | null>(null);
  const listId = useId();
  const latest = useRef({ catalog, onChange, onSend, onAttach });
  latest.current = { catalog, onChange, onSend, onAttach };
  const keyboard = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        dropcursor: false,
        underline: false,
        link: { openOnClick: false },
        trailingNode: false,
      }),
      Markdown.configure({ markedOptions: { breaks: true } }),
      skillExtension(() => latest.current.catalog.skills),
      Extension.create({
        name: "composerLimit",
        addProseMirrorPlugins() {
          const editor = this.editor;

          return [
            new Plugin({
              filterTransaction: (transaction) => {
                if (!transaction.docChanged) return true;

                const size =
                  editor.markdown?.serialize(transaction.doc.toJSON()).length ??
                  0;
                setLimitReached(size > 32000);

                return size <= 32000;
              },
            }),
          ];
        },
      }),
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        "data-placeholder": "Ask anything. $ skills, / commands",
      },
      handleKeyDown: (_view, event) => keyboard.current(event),
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);

        if (files.length && latest.current.onAttach) {
          event.preventDefault();
          latest.current.onAttach(files);

          return true;
        }

        const text = event.clipboardData?.getData("text/plain");

        if (!text) return false;

        // Never import arbitrary HTML or remote media from the clipboard.
        event.preventDefault();
        editor?.commands.insertContent(text, { contentType: "markdown" });

        return true;
      },
    },
    onUpdate: ({ editor }) => latest.current.onChange(editor.getMarkdown()),
    onTransaction: ({ editor }) => {
      const next = detectTrigger(editor);
      const key = next ? triggerKey(next) : null;

      if (!next) dismissed.current = null;

      setTrigger(dismissed.current === key ? null : next);
    },
  });
  const skillOptions =
    trigger?.kind === "skill"
      ? searchSkills(catalog.skills, trigger.query)
      : [];
  const commandOptions =
    trigger?.kind === "command"
      ? commands.filter((item) =>
          `${item.name} ${item.description}`
            .toLowerCase()
            .includes(trigger.query.toLowerCase()),
        )
      : [];
  const options = trigger?.kind === "skill" ? skillOptions : commandOptions;
  const activeIndex = Math.min(selected, Math.max(0, options.length - 1));

  function choose(index: number) {
    if (!editor || !trigger) return;

    if (trigger.kind === "skill") {
      const skill = skillOptions[index];

      if (!skill) return;

      editor
        .chain()
        .focus()
        .insertContentAt({ from: trigger.from, to: trigger.to }, [
          {
            type: "skill",
            attrs: { name: skill.name, description: skill.description },
          },
          { type: "text", text: " " },
        ])
        .run();
    } else {
      const command = commandOptions[index];

      if (!command) return;

      editor
        .chain()
        .focus()
        .deleteRange({ from: trigger.from, to: trigger.to })
        .run();
      command.run();
    }

    setTrigger(null);
  }

  keyboard.current = (event) => {
    if (event.isComposing || event.keyCode === 229) return false;

    if (trigger) {
      if (event.key === "Escape") {
        dismissed.current = triggerKey(trigger);
        setTrigger(null);

        return true;
      }

      if (["ArrowUp", "ArrowDown"].includes(event.key) && options.length) {
        setSelected(
          (activeIndex +
            (event.key === "ArrowDown" ? 1 : -1) +
            options.length) %
            options.length,
        );

        return true;
      }

      if (
        ["Enter", "Tab"].includes(event.key) &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (options.length) choose(activeIndex);

        // An open, empty/loading picker must not accidentally send a message.
        return event.key === "Enter" || options.length > 0;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      const block = editor?.state.selection.$from.parent;
      const fence =
        block?.type.name === "paragraph" &&
        /^```([\w-]*)$/.exec(block.textContent);

      if (editor && fence && !event.ctrlKey && !event.metaKey) {
        const start = editor.state.selection.$from.start();
        editor
          .chain()
          .deleteRange({ from: start, to: start + block!.content.size })
          .setCodeBlock({ language: fence[1] || "" })
          .run();

        return true;
      }

      if (
        !event.ctrlKey &&
        !event.metaKey &&
        (editor?.isActive("codeBlock") ||
          editor?.isActive("listItem") ||
          editor?.isActive("blockquote"))
      )
        return false;

      latest.current.onSend(event.ctrlKey || event.metaKey);

      return true;
    }

    return false;
  };

  useEffect(() => {
    if (!editor || editor.getMarkdown() === value) return;

    editor.commands.setContent(value, {
      contentType: "markdown",
      emitUpdate: false,
    });
  }, [editor, value]);

  useEffect(() => {
    const clearDrag = () => {
      dragDepth.current = 0;
      setDraggingFiles(false);
    };
    const cancelDrag = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearDrag();
    };
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("blur", clearDrag);
    window.addEventListener("keydown", cancelDrag);

    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("blur", clearDrag);
      window.removeEventListener("keydown", cancelDrag);
    };
  }, []);

  useEffect(() => {
    if (editor && !catalog.loading && !catalog.error)
      restoreSkillChips(editor, catalog.skills);
  }, [editor, catalog.skills, catalog.loading, catalog.error]);

  useEffect(() => {
    setSelected(0);
  }, [trigger?.query, trigger?.kind]);

  useEffect(() => {
    if (!editor) return;

    const dom = editor.view.dom;
    dom.setAttribute("aria-expanded", String(!!trigger));

    if (trigger) {
      dom.setAttribute("aria-controls", listId);
      dom.setAttribute("aria-autocomplete", "list");
      dom.setAttribute(
        "aria-activedescendant",
        options.length ? `${listId}-${activeIndex}` : "",
      );
      document
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
  }, [editor, trigger, listId, activeIndex, options.length]);

  return (
    <div
      className="composer-input"
      data-dragging-files={draggingFiles || undefined}
      onDragEnterCapture={(event) => {
        if (!onAttach || !event.dataTransfer.types.includes("Files")) return;

        event.preventDefault();
        dragDepth.current += 1;
        setDraggingFiles(true);
      }}
      onDragOverCapture={(event) => {
        if (!onAttach || !event.dataTransfer.types.includes("Files")) return;

        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setDraggingFiles(true);
      }}
      onDragLeaveCapture={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);

        if (dragDepth.current === 0) setDraggingFiles(false);
      }}
      onDropCapture={(event) => {
        dragDepth.current = 0;
        setDraggingFiles(false);

        if (onAttach && event.dataTransfer.files.length) {
          event.preventDefault();
          event.stopPropagation();
          onAttach(Array.from(event.dataTransfer.files));
        }
      }}
    >
      {draggingFiles && (
        <div className="composer-drop-overlay">
          <span role="status">
            <PaperclipIcon size={18} aria-hidden />
            Drop files to attach
          </span>
        </div>
      )}
      {trigger && (
        <div className="composer-suggestions">
          <div className="composer-suggestions-heading">
            <span>{trigger.kind === "skill" ? "Skills" : "Commands"}</span>
            <span>↑↓ navigate · Enter select · Esc close</span>
          </div>
          <div
            role="listbox"
            id={listId}
            aria-label={trigger.kind === "skill" ? "Skills" : "Commands"}
          >
            {options.map((option, index) => (
              <button
                key={option.name}
                type="button"
                role="option"
                id={`${listId}-${index}`}
                aria-selected={index === activeIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                <span className="composer-suggestion-symbol" aria-hidden>
                  {trigger.kind === "skill" ? "$" : "/"}
                </span>
                <span>
                  <strong>{option.name}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            ))}
          </div>
          {!options.length && (
            <div className="composer-suggestion-empty" role="status">
              {trigger.kind === "skill" ? (
                catalog.loading ? (
                  "Loading skills…"
                ) : catalog.error ? (
                  <>
                    {catalog.error}{" "}
                    <Button variant="ghost" onClick={catalog.refresh}>
                      Retry
                    </Button>
                  </>
                ) : catalog.skills.length ? (
                  "No matching skills."
                ) : (
                  "No skills installed for this agent. Add a SKILL.md under .agents/skills in its workspace."
                )
              ) : (
                "No matching commands."
              )}
            </div>
          )}
        </div>
      )}
      {!!attachments.length && (
        <div className="composer-files" aria-label="Attached files">
          {attachments.map((file) => (
            <div className="composer-file" key={file.id}>
              {file.mediaType.startsWith("image/") ? (
                <ChatImage
                  src={`/api/agents/${encodeURIComponent(agentId)}/chat/attachments/${file.id}`}
                  alt={file.name}
                />
              ) : (
                <FileIcon size={22} aria-hidden />
              )}
              <span className="composer-file-name" title={file.name}>
                <span>{file.name}</span>
                <small>
                  {(file.size ?? 0) >= 1024 * 1024
                    ? `${(file.size! / (1024 * 1024)).toFixed(1)} MB`
                    : `${Math.max(1, Math.round((file.size ?? 0) / 1024))} KB`}
                </small>
              </span>
              <Button
                variant="ghost"
                aria-label={`Remove ${file.name}`}
                onClick={() => onRemoveAttachment?.(file.id)}
              >
                <XIcon size={14} aria-hidden />
              </Button>
            </div>
          ))}
        </div>
      )}
      {uploading && (
        <div role="status" className="composer-limit">
          Uploading attachments…
        </div>
      )}
      {attachmentError && (
        <div role="alert" className="composer-limit">
          {attachmentError}
        </div>
      )}
      <EditorContent
        editor={editor}
        className="composer-editor"
        data-empty={editor?.isEmpty || undefined}
      />
      {limitReached && (
        <span role="status" className="composer-limit">
          Messages can contain up to 32,000 characters.
        </span>
      )}
      <div className="composer-toolbar">
        <div className="composer-tools">
          {onAttach && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                aria-label="Attach files"
                onChange={(event) => {
                  onAttach(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <Button
                className="composer-attach-button"
                variant="ghost"
                aria-label="Attach files"
                title="Attach files · paste or drag and drop"
                disabled={uploading || attachments.length >= 4}
                onClick={() => fileInput.current?.click()}
              >
                <PaperclipIcon size={16} aria-hidden />
              </Button>
            </>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
