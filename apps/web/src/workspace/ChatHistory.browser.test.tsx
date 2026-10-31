import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import type { Conversation, SendChat } from "@paws/contracts";
import {
  messageDisplayStorageKey,
  useChatPreferences,
} from "../settings/chatPreferences.ts";
import { ChatHistory } from "./ChatHistory.tsx";

const initial: Conversation = {
  agentId: "agent",
  revision: 1,
  status: "idle",
  error: null,
  selection: null,
  messages: [
    {
      id: "card",
      role: "assistant",
      text: "Where are we going?",
      createdAt: "2026-01-01",
      card: {
        text: "Where are we going?",
        actions: [{ id: "plan", label: "Plan trip" }],
        fields: [
          {
            id: "name",
            label: "Name",
            type: "text",
            required: true,
            choices: [],
          },
          {
            id: "destination",
            label: "Destination",
            type: "select",
            required: true,
            choices: [
              { id: "paris", label: "Paris" },
              { id: "rome", label: "Rome" },
            ],
          },
        ],
      },
    },
  ],
};

it("collects required form fields and button choices, then disables answered cards", async () => {
  const replies: NonNullable<SendChat["reply"]>[] = [];

  function Harness() {
    const [conversation, setConversation] = useState(initial);

    return (
      <ChatHistory
        conversation={conversation}
        busy={false}
        error={null}
        onReply={async (reply) => {
          replies.push(reply);
          setConversation({
            ...conversation,
            revision: 2,
            messages: conversation.messages.map((message) => ({
              ...message,
              response: "Submitted",
            })),
          });

          return true;
        }}
      />
    );
  }

  await using _screen = await render(<Harness />);
  expect(
    getComputedStyle(document.querySelector(".chat-card-form")!).padding,
  ).toBe("0px");
  expect(
    getComputedStyle(document.querySelector(".chat-card-field")!).margin,
  ).toBe("0px");
  await page.getByRole("button", { name: "Plan trip" }).click();
  expect(replies).toEqual([]);
  await page.getByRole("textbox", { name: "Name" }).fill("Ada");
  await page.getByRole("combobox", { name: "Destination" }).click();
  await page.getByRole("option", { name: "Paris", exact: true }).click();
  await page.getByRole("button", { name: "Plan trip" }).click();
  expect(replies).toEqual([
    {
      messageId: "card",
      actionId: "plan",
      values: { name: "Ada", destination: "paris" },
    },
  ]);
  await expect
    .element(page.getByText("Answered", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Plan trip" }))
    .not.toBeInTheDocument();
});

it("renders plain text safely, surfaces errors, and keeps controls available during a turn", async () => {
  await using _screen = await render(
    <ChatHistory
      conversation={{
        ...initial,
        status: "running",
        messages: [
          { ...initial.messages[0]!, text: '<img src=x onerror="alert(1)">' },
        ],
      }}
      busy={false}
      error="Connection failed"
      onReply={async () => true}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Plan trip" }))
    .toBeEnabled();
  await expect.element(page.getByRole("status")).toHaveTextContent("Thinking…");
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Connection failed");
  expect(document.querySelector(".chat-message img")).toBeNull();
});

it("renders agent Markdown images, links, lists and code without executing HTML or unsafe URLs", async () => {
  const text =
    '![A calico cat](https://example.com/cat.png)\n\nPhoto by **Himanshu** on [Unsplash](https://unsplash.com/photos/cat).\n\n- Cat\n- Kitten\n\n```js\nconst cat = true;\n```\n\n[unsafe](javascript:alert%281%29)\n\n<img src=x onerror="alert(1)">';
  await using _screen = await render(
    <ChatHistory
      conversation={{
        ...initial,
        messages: [{ ...initial.messages[0]!, text, card: undefined }],
      }}
      busy={false}
      error={null}
      onReply={async () => true}
    />,
  );
  await expect
    .element(page.getByRole("img", { name: "A calico cat" }))
    .toHaveAttribute("src", "https://example.com/cat.png");
  const link = page.getByRole("link", { name: "Unsplash", exact: true });
  await expect
    .element(link)
    .toHaveAttribute("href", "https://unsplash.com/photos/cat");
  await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
  expect(document.querySelector(".message-markdown strong")?.textContent).toBe(
    "Himanshu",
  );
  expect(document.querySelectorAll(".message-markdown li")).toHaveLength(2);
  expect(
    document.querySelector(".message-markdown pre code")?.textContent,
  ).toContain("const cat = true;");
  expect(
    document.querySelector(".message-markdown a[href^='javascript:']"),
  ).toBeNull();
  expect(document.querySelector(".message-markdown img[onerror]")).toBeNull();
});

it("shows persisted image attachments even with an empty final answer", async () => {
  const id = "a".repeat(64);
  await using _screen = await render(
    <ChatHistory
      conversation={{
        ...initial,
        messages: [
          {
            id: "image",
            role: "assistant",
            text: "",
            createdAt: "2026-01-01",
            attachments: [
              { id, name: "Generated image.png", mediaType: "image/png" },
            ],
          },
        ],
      }}
      busy={false}
      error={null}
      onReply={async () => true}
    />,
  );
  await expect
    .element(page.getByRole("img", { name: "Generated image.png" }))
    .toHaveAttribute("src", `/api/agents/agent/chat/attachments/${id}`);
  await expect
    .element(page.getByRole("button", { name: "Preview Generated image.png" }))
    .toBeVisible();
  await page
    .getByRole("button", { name: "Preview Generated image.png" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Generated image.png" });
  await expect.element(dialog).toBeVisible();
  await expect
    .element(
      dialog.getByRole("img", {
        name: "Generated image.png",
        includeHidden: true,
      }),
    )
    .toHaveAttribute("src", `/api/agents/agent/chat/attachments/${id}`);
  await page.getByRole("button", { name: "Close image preview" }).click();
});

it("groups messages by local calendar day and displays their saved timestamps", async () => {
  const dates = [
    new Date(2026, 0, 1, 23, 58),
    new Date(2026, 0, 1, 23, 59),
    new Date(2026, 0, 2, 0, 1),
  ];
  await using _screen = await render(
    <ChatHistory
      conversation={{
        ...initial,
        messages: [
          ...dates.map((date, index) => ({
            id: `message-${index}`,
            role: index === 1 ? ("user" as const) : ("assistant" as const),
            text: `Message ${index}`,
            createdAt: date.toISOString(),
          })),
          {
            id: "legacy",
            role: "assistant",
            text: "Legacy message without a valid date",
            createdAt: "",
          },
        ],
      }}
      busy={false}
      error={null}
      onReply={async () => true}
    />,
  );
  const separators = document.querySelectorAll(".chat-date-separator time");
  expect(
    [...separators].map((element) => element.getAttribute("datetime")),
  ).toEqual(["2026-01-01", "2026-01-02"]);
  const timestamps = document.querySelectorAll(".chat-message-time");
  expect(timestamps).toHaveLength(3);

  for (const [index, timestamp] of [...timestamps].entries()) {
    const date = dates[index]!;
    expect(timestamp.getAttribute("datetime")).toBe(date.toISOString());
    expect(timestamp.textContent).toBe(
      date.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(timestamp.getAttribute("title")).toContain("2026");
    expect(timestamp.getAttribute("aria-label")).toBe(
      timestamp.getAttribute("title"),
    );
  }

  await expect
    .element(page.getByText("Legacy message without a valid date"))
    .toBeVisible();
});

it("keeps short-message timestamps inline without overlapping wrapped text", async () => {
  await using _screen = await render(
    <div style={{ width: 360 }}>
      <ChatHistory
        conversation={{
          ...initial,
          messages: [
            {
              id: "short-user",
              role: "user",
              text: "Hello",
              createdAt: "2026-01-01T12:09:00Z",
            },
            {
              id: "short-agent",
              role: "assistant",
              text: "Hi there",
              createdAt: "2026-01-01T12:10:00Z",
            },
            {
              id: "wrapped",
              role: "assistant",
              text: "This longer message wraps across several lines, leaving room for its timestamp at the end.",
              createdAt: "2026-01-01T12:11:00Z",
            },
          ],
        }}
        busy={false}
        error={null}
        onReply={async () => true}
      />
    </div>,
  );
  const bubbles = document.querySelectorAll(".chat-message-bubble");

  for (const [index, bubble] of [...bubbles].entries()) {
    const paragraph = bubble.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const lastLine = [...range.getClientRects()].at(-1)!;
    const timestamp = bubble
      .querySelector(".chat-message-time")!
      .getBoundingClientRect();

    if (index < 2) {
      expect(bubble.getBoundingClientRect().height).toBeLessThan(45);
      expect(timestamp.top).toBeLessThan(lastLine.bottom);
    }

    if (timestamp.top < lastLine.bottom) {
      expect(timestamp.left).toBeGreaterThanOrEqual(lastLine.right);
    } else {
      expect(timestamp.top).toBeGreaterThanOrEqual(lastLine.bottom);
    }

    expect(timestamp.bottom).toBeLessThan(
      bubble.getBoundingClientRect().bottom,
    );
  }
});

it("renders saved handoffs between messages and previews provider changes without creating a bubble", async () => {
  const codex = {
    providerId: "codex",
    modelId: "gpt-test",
    name: "GPT-Test",
    driver: "codex" as const,
  };
  const openCode = {
    providerId: "opencode",
    modelId: "deepseek",
    name: "DeepSeek Free",
    driver: "opencode" as const,
  };
  const conversation: Conversation = {
    ...initial,
    selection: { providerId: "opencode", modelId: "deepseek", options: {} },
    messages: [
      {
        id: "first",
        role: "assistant",
        text: "Earlier answer",
        createdAt: "2026-01-01",
        model: codex,
      },
      { id: "next", role: "user", text: "Continue", createdAt: "2026-01-01" },
      {
        id: "reply",
        role: "assistant",
        text: "Latest answer",
        createdAt: "2026-01-01",
        model: openCode,
      },
    ],
    handoffs: [
      {
        id: "transfer",
        beforeMessageId: "next",
        from: [codex],
        to: openCode,
        status: "completed",
      },
    ],
  };

  function Harness() {
    const [model, setModel] = useState(codex);

    return (
      <div style={{ width: 360 }}>
        <button onClick={() => setModel({ ...codex, providerId: "opencode" })}>
          Cancel switch
        </button>
        <ChatHistory
          conversation={conversation}
          selectedModel={model}
          busy={false}
          error={null}
          onReply={async () => true}
        />
      </div>
    );
  }

  await using _screen = await render(<Harness />);
  await expect
    .element(page.getByRole("status", { name: "Context handoff", exact: true }))
    .toBeVisible();
  await expect
    .element(
      page.getByRole("status", {
        name: "Context handoff pending",
        exact: true,
      }),
    )
    .toBeVisible();
  const divider = document.querySelector(".chat-handoff")!;
  expect(divider.previousElementSibling?.textContent).toContain(
    "Earlier answer",
  );
  expect(divider.nextElementSibling?.textContent).toContain("Continue");
  expect(document.querySelectorAll("article.chat-message")).toHaveLength(3);
  expect(divider.getBoundingClientRect().width).toBeLessThanOrEqual(360);
  expect(getComputedStyle(divider, "::before").height).toBe("1px");
  await page.getByRole("button", { name: "Cancel switch" }).click();
  await expect
    .element(
      page.getByRole("status", {
        name: "Context handoff pending",
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
});

it("replaces the pending preview with one committed divider as the switch starts", async () => {
  const source = { providerId: "first", modelId: "one", name: "First" };
  const target = { providerId: "second", modelId: "two", name: "Second" };

  function Harness() {
    const [started, setStarted] = useState(false);

    return (
      <>
        <button onClick={() => setStarted(true)}>Start switch</button>
        <ChatHistory
          conversation={{
            ...initial,
            status: started ? "running" : "idle",
            selection: { ...(started ? target : source), options: {} },
            messages: [
              {
                id: "old",
                role: "assistant",
                text: "Earlier answer",
                createdAt: "2026-01-01",
                model: source,
              },
              ...(started
                ? [
                    {
                      id: "next",
                      role: "user" as const,
                      text: "Continue",
                      createdAt: "2026-01-01",
                    },
                  ]
                : []),
            ],
            handoffs: started
              ? [
                  {
                    id: "next",
                    beforeMessageId: "next",
                    kind: "provider-switch",
                    from: [
                      source,
                      { ...source, modelId: "older", name: "Older" },
                    ],
                    to: target,
                    status: "pending",
                  },
                ]
              : [],
          }}
          selectedModel={target}
          busy={false}
          error={null}
          onReply={async () => true}
        />
      </>
    );
  }

  await using _screen = await render(<Harness />);
  await expect
    .element(
      page.getByRole("status", {
        name: "Context handoff pending",
        exact: true,
      }),
    )
    .toBeVisible();
  await page.getByRole("button", { name: "Start switch" }).click();
  await expect
    .element(
      page.getByRole("status", {
        name: "Context handoff pending",
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  const divider = page.getByRole("status", {
    name: "Context handoff",
    exact: true,
  });
  await expect.element(divider).toBeVisible();
  expect(divider.element().textContent).toContain("Older");
  expect(document.querySelectorAll(".chat-handoff")).toHaveLength(1);
  await expect.element(page.getByText("Thinking…")).toBeVisible();
});

it("buffers unfinished text by default, shows cards, and switches display modes live", async () => {
  localStorage.removeItem(messageDisplayStorageKey);

  function Harness() {
    const { messageDisplay, setMessageDisplay } = useChatPreferences();
    const [complete, setComplete] = useState(false);

    return (
      <>
        <button
          onClick={() =>
            setMessageDisplay(
              messageDisplay === "whole" ? "streaming" : "whole",
            )
          }
        >
          Toggle display
        </button>
        <button onClick={() => setComplete(true)}>Finish message</button>
        <ChatHistory
          conversation={{
            ...initial,
            status: "running",
            revision: complete ? 2 : 1,
            messages: [
              ...initial.messages,
              {
                id: "text",
                role: "assistant",
                text: complete ? "Finished reply" : "Partial reply",
                createdAt: "2026-01-01",
                streaming: !complete,
              },
            ],
          }}
          busy={false}
          error={null}
          onReply={async () => true}
        />
      </>
    );
  }

  try {
    await using _screen = await render(<Harness />);
    await expect
      .element(page.getByText("Partial reply", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Plan trip" }))
      .toBeEnabled();
    await page.getByRole("button", { name: "Toggle display" }).click();
    await expect
      .element(page.getByText("Partial reply", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Toggle display" }).click();
    await expect
      .element(page.getByText("Partial reply", { exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Finish message" }).click();
    await expect
      .element(page.getByText("Finished reply", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("Thinking…", { exact: true }))
      .toBeVisible();
  } finally {
    localStorage.removeItem(messageDisplayStorageKey);
  }
});

it("keeps legacy restoration invisible before and during buffered output", async () => {
  const model = {
    providerId: "codex",
    modelId: "model",
    name: "Model",
    driver: "codex" as const,
  };

  function Harness() {
    const [reply, setReply] = useState(false);

    return (
      <>
        <button onClick={() => setReply(true)}>Start reply</button>
        <ChatHistory
          conversation={{
            ...initial,
            status: "running",
            messages: [
              {
                id: "turn",
                role: "user",
                text: "Inspect this",
                createdAt: "2026-01-01",
              },
              ...(reply
                ? [
                    {
                      id: "turn:reply",
                      role: "assistant" as const,
                      text: "I will inspect it.",
                      streaming: true,
                      createdAt: "2026-01-01",
                      model,
                    },
                  ]
                : []),
            ],
            handoffs: [
              {
                id: "turn",
                beforeMessageId: "turn",
                from: [model],
                to: model,
                status: "pending",
              },
            ],
          }}
          busy={false}
          error={null}
          onReply={async () => true}
        />
      </>
    );
  }

  localStorage.removeItem(messageDisplayStorageKey);
  await using _screen = await render(<Harness />);
  await expect
    .element(page.getByText("Restoring conversation context…"))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Start reply" }).click();
  await expect
    .element(page.getByText("Restoring conversation context…"))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("Thinking…")).toBeVisible();
});

it("keeps bubble dimensions stable from sending through queued and sent, including attachments", async () => {
  function Harness() {
    const [phase, setPhase] = useState(0);
    const messages = [
      { id: "short", text: "Hello" },
      {
        id: "wrapped",
        text: "This longer message should wrap without changing height when sending finishes.",
      },
      {
        id: "file",
        text: "",
        attachments: [
          {
            id: "a".repeat(64),
            name: "report.pdf",
            mediaType: "application/pdf",
            size: 1024,
          },
        ],
      },
    ].map((message) => ({
      ...message,
      role: "user" as const,
      createdAt: "2026-01-01T12:00:00Z",
      ...(phase
        ? {
            delivery:
              phase === 1 ? ("queued" as const) : ("delivered" as const),
          }
        : {}),
    }));

    return (
      <div style={{ width: 320 }}>
        <button onClick={() => setPhase((value) => value + 1)}>
          Advance send
        </button>
        <ChatHistory
          conversation={{ ...initial, messages }}
          outgoing={
            phase === 0
              ? { short: "sending", wrapped: "sending", file: "sending" }
              : {}
          }
          busy={false}
          error={null}
          onReply={async () => true}
        />
      </div>
    );
  }

  await using _screen = await render(<Harness />);
  const dimensions = () =>
    [...document.querySelectorAll(".chat-message-bubble")].map((bubble) => {
      const { width, height } = bubble.getBoundingClientRect();

      return { width, height };
    });
  const before = dimensions();
  expect(document.querySelectorAll('[aria-label="Sending"]')).toHaveLength(3);
  await page.getByRole("button", { name: "Advance send" }).click();
  await expect
    .poll(() => document.querySelectorAll('[aria-label="Queued"]').length)
    .toBe(3);
  expect(dimensions()).toEqual(before);
  await page.getByRole("button", { name: "Advance send" }).click();
  await expect
    .poll(() => document.querySelectorAll('[aria-label="Sent"]').length)
    .toBe(3);
  expect(dimensions()).toEqual(before);
});
