import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ComposerInput } from "./ComposerInput.tsx";

const skills = [
  {
    name: "writer",
    description: "Write clear prose",
    path: "/home/agent/.agents/skills/writer/SKILL.md",
  },
  {
    name: "review",
    description: "Review code",
    path: "/home/agent/.agents/skills/review/SKILL.md",
  },
];

function Harness({
  initial = "",
  send = (_text: string, _alternate: boolean) => {},
}) {
  const [value, setValue] = useState(initial);

  return (
    <div style={{ width: "min(560px, 100vw)", marginTop: 330 }}>
      <ComposerInput
        agentId="composer-test"
        label="Message Ada"
        value={value}
        onChange={setValue}
        onSend={(alternate) => send(value, alternate)}
      >
        <button onClick={() => setValue("**Restored draft**")}>
          Restore draft
        </button>
      </ComposerInput>
      <output aria-label="Markdown">{value}</output>
    </div>
  );
}

it("searches skills, inserts a chip without sending, persists Markdown, supports undo and Escape", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => Response.json(skills));
  const send = vi.fn();

  try {
    await using _screen = await render(<Harness send={send} />);
    const input = page.getByRole("textbox", { name: "Message Ada" });
    await input.fill("Use $w");
    await expect
      .element(page.getByRole("option", { name: /writer/ }))
      .toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(send).not.toHaveBeenCalled();
    expect(input.element().querySelector("[data-skill=writer]")).not.toBeNull();
    await expect
      .element(page.getByLabelText("Markdown"))
      .toHaveTextContent("Use $writer");
    await userEvent.keyboard("{Control>}z{/Control}");
    expect(input.element().querySelector("[data-skill=writer]")).toBeNull();
    await input.fill("$no-match");
    await expect.element(page.getByText("No matching skills.")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(send).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(send).toHaveBeenCalledWith("$no-match", false);
    await input.fill("$");
    await expect
      .element(page.getByRole("option", { name: /writer/ }))
      .toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Tab}");
    expect(input.element().querySelector("[data-skill=writer]")).not.toBeNull();
  } finally {
    fetch.mockRestore();
  }
});

it("formats selections, restores rich drafts, and supports code blocks without accidental sends", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => Response.json(skills));
  const send = vi.fn();

  try {
    await using _screen = await render(<Harness send={send} />);
    const input = page.getByRole("textbox", { name: "Message Ada" });
    await input.fill("important");
    await userEvent.keyboard("{Control>}a{/Control}{Control>}b{/Control}");
    await expect
      .element(page.getByLabelText("Markdown"))
      .toHaveTextContent("**important**");
    expect(input.element().querySelector("strong")?.textContent).toBe(
      "important",
    );
    await page.getByRole("button", { name: "Restore draft" }).click();
    expect(input.element().querySelector("strong")?.textContent).toBe(
      "Restored draft",
    );
    await input.fill("```");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("const x = 1{Enter}const y = 2");
    expect(send).not.toHaveBeenCalled();
    expect(input.element().querySelector("pre")?.textContent).toContain(
      "const y = 2",
    );
    expect(page.getByLabelText("Markdown").element().textContent).toContain(
      "```",
    );
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining("const x = 1"),
      true,
    );
  } finally {
    fetch.mockRestore();
  }
});

it("shows loading, failure and retry states without blocking ordinary messages", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockRejectedValue(new Error("offline"));
  const send = vi.fn();

  try {
    await using _screen = await render(<Harness send={send} />);
    const input = page.getByRole("textbox", { name: "Message Ada" });
    await input.fill("$");
    await expect
      .element(page.getByText(/Could not load skills\./))
      .toBeVisible();
    fetch.mockImplementation(async () => Response.json([]));
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByText(/No skills installed/)).toBeVisible();
    await input.fill("Ordinary message");
    await userEvent.keyboard("{Enter}");
    expect(send).toHaveBeenCalledWith("Ordinary message", false);
  } finally {
    fetch.mockRestore();
  }
});

it("restores skill chips with formatted drafts and preserves pasted Markdown", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => Response.json(skills));

  try {
    await using _screen = await render(
      <Harness initial="Use $writer for **this**" />,
    );
    const input = page.getByRole("textbox", { name: "Message Ada" });
    await expect
      .poll(
        () => input.element().querySelector("[data-skill=writer]")?.textContent,
      )
      .toBe("$writer");
    expect(input.element().querySelector("strong")?.textContent).toBe("this");
    await input.fill("");
    const pasteTarget = input.element();
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "**Pasted** and `code`");
    clipboard.setData(
      "text/html",
      '<img src="https://example.invalid/tracker" onerror="alert(1)">',
    );
    pasteTarget.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
    await expect
      .element(page.getByLabelText("Markdown"))
      .toHaveTextContent("**Pasted** and `code`");
    expect(input.element().querySelector("strong")?.textContent).toBe("Pasted");
    expect(input.element().querySelector("img")).toBeNull();
    const width = input.element().getBoundingClientRect().width;
    expect(input.element().scrollWidth).toBeLessThanOrEqual(Math.ceil(width));
  } finally {
    fetch.mockRestore();
  }
});

it("uses slash commands for actions and Markdown syntax for formatting", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => Response.json([]));
  const command = vi.fn();
  const send = vi.fn();
  function Commands() {
    const [value, setValue] = useState("");

    return (
      <div style={{ marginTop: 300 }}>
        <ComposerInput
          agentId="commands"
          label="Message"
          value={value}
          onChange={setValue}
          onSend={send}
          commands={[
            { name: "model", description: "Choose a model", run: command },
          ]}
        >
          {null}
        </ComposerInput>
      </div>
    );
  }

  try {
    await using _screen = await render(<Commands />);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("/mod");
    await expect
      .element(page.getByRole("listbox", { name: "Commands" }))
      .toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(command).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    await input.fill("");
    await userEvent.keyboard("**bold** ");
    expect(input.element().querySelector("strong")?.textContent).toBe("bold");
    await input.fill("");
    await userEvent.keyboard("- item");
    expect(input.element().querySelector("li")?.textContent).toBe("item");
    await userEvent.keyboard("{Enter}next");
    expect(input.element().querySelectorAll("li")).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});

it("accepts dropped and pasted files, displays attachments, and removes them", async () => {
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => Response.json([]));
  const attach = vi.fn();
  const remove = vi.fn();
  const file = {
    id: "a".repeat(64),
    name: "report.pdf",
    mediaType: "application/pdf",
    size: 100,
  };

  try {
    await using _screen = await render(
      <ComposerInput
        agentId="files"
        label="Message"
        value=""
        onChange={() => {}}
        onSend={() => {}}
        attachments={[file]}
        onAttach={attach}
        onRemoveAttachment={remove}
      >
        {null}
      </ComposerInput>,
    );
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const dropTarget = input.element();
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
    dropTarget.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(attach).toHaveBeenCalledWith([
      expect.objectContaining({ name: "note.txt" }),
    ]);
    const drag = (type: string) =>
      dropTarget.dispatchEvent(
        new DragEvent(type, {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    drag("dragenter");
    drag("dragover");
    await expect.element(page.getByText("Drop files to attach")).toBeVisible();
    expect(document.querySelector(".prosemirror-dropcursor-block")).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect
      .element(page.getByText("Drop files to attach"))
      .not.toBeInTheDocument();
    drag("dragenter");
    await expect.element(page.getByText("Drop files to attach")).toBeVisible();
    dropTarget.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(attach).toHaveBeenCalledTimes(2);
    await expect
      .element(page.getByText("Drop files to attach"))
      .not.toBeInTheDocument();
    expect(
      getComputedStyle(
        page.getByRole("button", { name: "Remove report.pdf" }).element(),
      ).backgroundColor,
    ).toBe("rgba(0, 0, 0, 0)");
    await page.getByRole("button", { name: "Remove report.pdf" }).click();
    expect(remove).toHaveBeenCalledWith(file.id);
  } finally {
    fetch.mockRestore();
  }
});
