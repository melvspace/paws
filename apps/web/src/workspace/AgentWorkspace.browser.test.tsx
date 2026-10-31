import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import {
  providersAtom,
  conversationsAtom,
  outgoingMessagesAtom,
} from "@paws/client-runtime";
import type { Conversation, SendChat } from "@paws/contracts";
import { appAtomRegistry } from "../lib/atomRegistry.ts";
import { codexFixture } from "../../test/providerFixtures.ts";
import { AgentWorkspace } from "./AgentWorkspace.tsx";
import { followUpStorageKey } from "../settings/chatPreferences.ts";

const agent = {
  id: "chat-test",
  name: "Ada",
  provider: "codex",
  status: "configured",
  createdAt: "2026-01-01",
} as const;

afterEach(() => appAtomRegistry.set(outgoingMessagesAtom, []));

it("sends follow-ups while running, uses the saved default, and supports a one-message override", async () => {
  localStorage.setItem(followUpStorageKey, "queue");
  localStorage.setItem(
    `paws.workspace.${agent.id}`,
    JSON.stringify({ sidebarOpen: false, options: {} }),
  );
  const conversation: Conversation = {
    agentId: agent.id,
    revision: 10,
    status: "running",
    error: null,
    selection: {
      providerId: "codex",
      modelId: codexFixture.models[0]!.id,
      options: {},
    },
    messages: [],
  };
  const submissions: SendChat[] = [];
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  appAtomRegistry.set(conversationsAtom, [conversation]);
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (_url, options) => {
      if (options?.method === "POST")
        submissions.push(JSON.parse(String(options.body)));

      return Response.json({
        ...conversation,
        revision: 10 + submissions.length,
      });
    });

  try {
    await using _screen = await render(
      <AgentWorkspace
        agent={agent}
        onSettings={() => {}}
        onProviderSettings={() => {}}
      />,
    );
    const composer = page.getByRole("textbox", { name: "Message Ada" });
    const stop = page.getByRole("button", { name: "Stop reply", exact: true });
    await expect.element(stop).toBeVisible();
    const buttonSize = window.matchMedia("(max-width: 640px)").matches
      ? "36px"
      : "32px";
    expect(getComputedStyle(stop.element()).width).toBe(buttonSize);
    expect(getComputedStyle(stop.element()).height).toBe(buttonSize);
    expect(getComputedStyle(stop.element()).borderRadius).toBe("50%");
    const stopColor = getComputedStyle(stop.element()).backgroundColor;
    await composer.fill("After this, check the tests");
    await expect.element(stop).not.toBeInTheDocument();
    const queue = page.getByRole("button", {
      name: "Queue message",
      exact: true,
    });
    expect(getComputedStyle(queue.element()).backgroundColor).not.toBe(
      stopColor,
    );
    expect(queue.element().querySelector(".lucide-list-plus")).not.toBeNull();
    await page
      .getByRole("button", { name: "Queue message", exact: true })
      .click();
    await expect.poll(() => composer.element().textContent).toBe("");
    expect(submissions[0]?.mode).toBe("queue");
    await composer.fill("Actually, stop editing that file");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await expect.poll(() => composer.element().textContent).toBe("");
    expect(submissions[1]?.mode).toBe("steer");
    await composer.fill("One more correction");
    await userEvent.keyboard("{Control>}");
    const steer = page.getByRole("button", {
      name: "Steer message",
      exact: true,
    });
    await expect.element(steer).toBeVisible();
    expect(
      steer.element().querySelector(".lucide-corner-up-right"),
    ).not.toBeNull();
    await userEvent.keyboard("{/Control}");
    await expect.element(queue).toBeVisible();
    await queue.click({ modifiers: ["Control"] });
    await expect.poll(() => composer.element().textContent).toBe("");
    expect(submissions[2]?.mode).toBe("steer");
    await expect.element(stop).toBeVisible();
    await composer.fill("Keep the default");
    await expect.element(queue).toBeVisible();
    await userEvent.keyboard("{Meta>}");
    await expect.element(steer).toBeVisible();
    window.dispatchEvent(new Event("blur"));
    await expect.element(queue).toBeVisible();
    await userEvent.keyboard("{/Meta}");
    expect(localStorage.getItem(followUpStorageKey)).toBe("queue");
  } finally {
    fetchMock.mockRestore();
    localStorage.removeItem(followUpStorageKey);
    localStorage.removeItem(`paws.workspace.${agent.id}`);
  }
});

it("sends on Enter, preserves newlines, receives replies and stops the active turn", async () => {
  let conversation: Conversation = {
    agentId: agent.id,
    revision: 0,
    status: "idle",
    error: null,
    selection: null,
    messages: [],
  };
  const submissions: SendChat[] = [];
  localStorage.setItem(
    `paws.workspace.${agent.id}`,
    JSON.stringify({ sidebarOpen: false, options: {} }),
  );
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  appAtomRegistry.set(conversationsAtom, []);
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (url, options) => {
      if (options?.method === "POST") {
        if (String(url).endsWith("/stop"))
          conversation = { ...conversation, revision: 3, status: "idle" };
        else {
          const body: SendChat = JSON.parse(String(options.body));
          submissions.push(body);
          conversation = {
            ...conversation,
            revision: 1,
            status: "running",
            selection: body.selection,
            messages: [
              {
                id: body.requestId,
                role: "user",
                text: body.text,
                createdAt: "2026-01-01",
              },
            ],
          };
        }
      }

      return Response.json(conversation);
    });

  try {
    await using _screen = await render(
      <AgentWorkspace
        agent={agent}
        onSettings={() => {}}
        onProviderSettings={() => {}}
      />,
    );
    const composer = page.getByRole("textbox", { name: "Message Ada" });
    await composer.fill("Hello");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(submissions).toHaveLength(0);
    await composer.fill("Hello Ada");
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("button", { name: "Stop reply" }))
      .toBeVisible();
    await expect.poll(() => composer.element().textContent).toBe("");
    expect(submissions[0]).toMatchObject({
      text: "Hello Ada",
      selection: { providerId: "codex", modelId: codexFixture.models[0]!.id },
    });
    conversation = {
      ...conversation,
      revision: 2,
      messages: [
        ...conversation.messages,
        {
          id: "response",
          role: "assistant",
          text: "Hello there",
          createdAt: "2026-01-01",
        },
      ],
    };
    appAtomRegistry.set(conversationsAtom, [conversation]);
    await expect
      .element(page.getByText("Hello there", { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Stop reply" }).click();
    await expect
      .element(page.getByRole("button", { name: "Send message" }))
      .toBeVisible();
  } finally {
    fetchMock.mockRestore();
    localStorage.removeItem(`paws.workspace.${agent.id}`);
  }
});

it("keeps failed messages recoverable in the chat without refilling the composer", async () => {
  localStorage.setItem(
    `paws.workspace.${agent.id}`,
    JSON.stringify({ sidebarOpen: false, options: {} }),
  );
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  appAtomRegistry.set(conversationsAtom, []);
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (_url, options) =>
      options?.method === "POST"
        ? Response.json({ error: "Provider unavailable" }, { status: 400 })
        : Response.json({
            agentId: agent.id,
            revision: 0,
            status: "idle",
            error: null,
            selection: null,
            messages: [],
          }),
    );

  try {
    await using _screen = await render(
      <AgentWorkspace
        agent={agent}
        onSettings={() => {}}
        onProviderSettings={() => {}}
      />,
    );
    const composer = page.getByRole("textbox", { name: "Message Ada" });
    await composer.fill("Keep this draft");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Provider unavailable");
    await expect.element(composer).toHaveTextContent("");
    await expect
      .element(page.getByText("Keep this draft", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Retry message" }))
      .toBeVisible();
  } finally {
    fetchMock.mockRestore();
    localStorage.removeItem(`paws.workspace.${agent.id}`);
  }
});

it("restores the conversation model and options, then remembers a newer unsent choice per agent", async () => {
  const key = `paws.workspace.${agent.id}`;
  localStorage.setItem(key, JSON.stringify({ sidebarOpen: false }));
  const conversation: Conversation = {
    agentId: agent.id,
    revision: 1,
    status: "idle",
    error: null,
    selection: {
      providerId: "codex",
      modelId: "gpt-6-astra",
      options: { reasoningEffort: "high", serviceTier: "fast" },
    },
    messages: [],
  };
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  appAtomRegistry.set(conversationsAtom, [conversation]);
  const fetchMock = vi
    .spyOn(window, "fetch")
    .mockImplementation(async () => Response.json(conversation));

  try {
    {
      await using _screen = await render(
        <AgentWorkspace
          agent={agent}
          onSettings={() => {}}
          onProviderSettings={() => {}}
        />,
      );
      await expect
        .element(
          page.getByRole("button", {
            name: "Choose model: GPT-6-Astra",
            exact: true,
          }),
        )
        .toBeVisible();
      await expect
        .element(
          page.getByRole("button", {
            name: "Reasoning: High, Fast",
            exact: true,
          }),
        )
        .toBeVisible();
      await page
        .getByRole("button", { name: "Choose model: GPT-6-Astra", exact: true })
        .click();
      await page.getByRole("option", { name: /GPT-6.1-Sol/ }).click();
      await expect
        .element(
          page.getByRole("button", {
            name: "Choose model: GPT-6.1-Sol",
            exact: true,
          }),
        )
        .toBeVisible();
    }

    expect(JSON.parse(localStorage.getItem(key)!).model).toBe(
      "codex:gpt-6.1-sol",
    );
    // A fresh mount represents returning to the agent or reloading the page.
    {
      await using _screen = await render(
        <AgentWorkspace
          agent={agent}
          onSettings={() => {}}
          onProviderSettings={() => {}}
        />,
      );
      await expect
        .element(
          page.getByRole("button", {
            name: "Choose model: GPT-6.1-Sol",
            exact: true,
          }),
        )
        .toBeVisible();
    }

    expect(localStorage.getItem("paws.workspace.other-agent")).toBeNull();
  } finally {
    fetchMock.mockRestore();
    localStorage.removeItem(key);
  }
});

it("uploads attachments from the composer, retains them after a failed send, and sends without text", async () => {
  const attachment = {
    id: "b".repeat(64),
    name: "notes.txt",
    mediaType: "application/octet-stream",
    size: 5,
    path: "/workspace/.paws-upload-test/notes.txt",
  };
  const conversation: Conversation = {
    agentId: agent.id,
    revision: 0,
    status: "idle",
    error: null,
    selection: null,
    messages: [],
  };
  const submissions: SendChat[] = [];
  let fail = true;
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  appAtomRegistry.set(conversationsAtom, [conversation]);
  localStorage.setItem(
    `paws.workspace.${agent.id}`,
    JSON.stringify({ sidebarOpen: false }),
  );
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (url, options) => {
      if (String(url).endsWith("/skills")) return Response.json([]);
      if (String(url).endsWith("/uploads"))
        return Response.json(attachment, { status: 201 });
      if (options?.method === "POST") {
        const body: SendChat = JSON.parse(String(options.body));
        submissions.push(body);

        if (fail)
          return Response.json({ error: "Please retry" }, { status: 503 });

        return Response.json({
          ...conversation,
          revision: 1,
          messages: [
            {
              id: body.requestId,
              role: "user",
              text: "",
              createdAt: "2026-01-01",
              attachments: [attachment],
            },
          ],
        });
      }

      return Response.json(conversation);
    });

  try {
    await using _screen = await render(
      <AgentWorkspace
        agent={agent}
        onSettings={() => {}}
        onProviderSettings={() => {}}
      />,
    );
    const input = page.getByRole("textbox", { name: "Message Ada" }).element();
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "notes.txt"));
    input.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    await expect
      .element(page.getByRole("button", { name: "Remove notes.txt" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.element(page.getByText("Please retry")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Remove notes.txt" }))
      .not.toBeInTheDocument();
    fail = false;
    await page.getByRole("button", { name: "Retry message" }).click();
    await expect
      .element(page.getByRole("button", { name: "Remove notes.txt" }))
      .not.toBeInTheDocument();
    expect(submissions[0]).toMatchObject({
      text: "",
      attachmentIds: [attachment.id],
    });
    expect(submissions[1]?.requestId).toBe(submissions[0]?.requestId);
    await expect
      .element(page.getByRole("link", { name: /notes.txt/ }))
      .toBeVisible();
  } finally {
    fetch.mockRestore();
    localStorage.removeItem(`paws.workspace.${agent.id}`);
  }
});

it("shows a send immediately, preserves new typing, and reconciles WebSocket acknowledgement before HTTP", async () => {
  const conversation: Conversation = {
    agentId: agent.id,
    revision: 0,
    status: "idle",
    error: null,
    selection: null,
    messages: [],
  };
  appAtomRegistry.set(providersAtom, {
    providers: [codexFixture],
    error: null,
  });
  appAtomRegistry.set(conversationsAtom, [conversation]);
  localStorage.setItem(
    `paws.workspace.${agent.id}`,
    JSON.stringify({ sidebarOpen: false }),
  );
  let submission: SendChat | undefined;
  let finish: (response: Response) => void = () => {};
  const fetch = vi
    .spyOn(window, "fetch")
    .mockImplementation(async (url, options) => {
      if (String(url).endsWith("/skills")) return Response.json([]);
      if (options?.method === "POST") {
        submission = JSON.parse(String(options.body));

        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }

      return Response.json(conversation);
    });

  try {
    await using _screen = await render(
      <AgentWorkspace
        agent={agent}
        onSettings={() => {}}
        onProviderSettings={() => {}}
      />,
    );
    const composer = page.getByRole("textbox", { name: "Message Ada" });
    await composer.fill("Send this immediately");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect.element(composer).toHaveTextContent("");
    await expect
      .element(page.getByText("Send this immediately", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("status", { name: "Sending", exact: true }))
      .toBeVisible();
    await composer.fill("My next message");
    // An unrelated snapshot must not erase the local message.
    appAtomRegistry.set(conversationsAtom, [{ ...conversation, revision: 1 }]);
    await expect
      .element(page.getByText("Send this immediately", { exact: true }))
      .toBeVisible();
    appAtomRegistry.set(conversationsAtom, [
      {
        ...conversation,
        revision: 2,
        status: "running",
        messages: [
          {
            id: submission!.requestId,
            role: "user",
            text: submission!.text,
            createdAt: "2026-01-01",
          },
        ],
      },
    ]);
    await expect
      .element(page.getByRole("status", { name: "Sending", exact: true }))
      .not.toBeInTheDocument();
    expect(document.querySelectorAll('article[data-role="user"]')).toHaveLength(
      1,
    );
    // The server accepted the send even if its HTTP response was lost.
    finish(Response.json({ error: "Connection lost" }, { status: 503 }));
    await expect.element(composer).toHaveTextContent("My next message");
    await expect
      .element(page.getByRole("button", { name: "Steer message", exact: true }))
      .toBeEnabled();
    expect(document.querySelectorAll('article[data-role="user"]')).toHaveLength(
      1,
    );
    await expect
      .element(page.getByRole("button", { name: "Retry message" }))
      .not.toBeInTheDocument();
  } finally {
    finish(Response.json(conversation));
    fetch.mockRestore();
    localStorage.removeItem(`paws.workspace.${agent.id}`);
  }
});
