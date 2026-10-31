import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { Conversation, ChatQueueAction } from "@paws/contracts";
import { render } from "../../test/render.tsx";
import { ChatHistory } from "./ChatHistory.tsx";

const selection = { providerId: "codex", modelId: "model", options: {} };
const initial: Conversation = {
  agentId: "agent",
  revision: 1,
  status: "idle",
  error: null,
  selection,
  interrupted: { requestId: "original", selection, activity: "reply" },
  queue: [{ requestId: "queued", text: "Make 2k", selection, held: true }],
  messages: [
    {
      id: "original",
      role: "user",
      text: "Make a video",
      createdAt: "2026-10-31",
      delivery: "delivered",
    },
    {
      id: "queued",
      role: "user",
      text: "Make 2k",
      createdAt: "2026-10-31",
      delivery: "queued",
    },
    {
      id: "old",
      role: "user",
      text: "Old cancelled request",
      createdAt: "2026-10-31",
      delivery: "cancelled",
    },
  ],
};

it("shows a held queue instead of sent bubbles, retains failed edits, and offers recovery controls", async () => {
  const updates: ChatQueueAction[] = [];
  const onContinue = vi.fn(async () => true);
  const restore = vi.fn();
  let allowEdit = false;

  function Harness() {
    const [conversation, setConversation] = useState(initial);

    return (
      <div style={{ width: 320 }}>
        <ChatHistory
          conversation={conversation}
          busy={false}
          error={null}
          onReply={async () => true}
          onContinue={onContinue}
          onRestoreDraft={restore}
          onQueueUpdate={async (action) => {
            updates.push(action);

            if (action.action === "edit" && !allowEdit) return false;

            setConversation((current) => ({
              ...current,
              queue:
                action.action === "remove"
                  ? []
                  : current.queue?.map((entry) => ({
                      ...entry,
                      ...(action.action === "edit"
                        ? { text: action.text }
                        : {}),
                      held: action.action !== "resume",
                    })),
              messages: current.messages
                .filter(
                  (message) =>
                    action.action !== "remove" ||
                    message.id !== action.requestId,
                )
                .map((message) =>
                  message.id === action.requestId
                    ? {
                        ...message,
                        text:
                          action.action === "edit" ? action.text : message.text,
                      }
                    : message,
                ),
            }));

            return true;
          }}
        />
      </div>
    );
  }

  await using _screen = await render(<Harness />);
  await expect
    .element(page.getByText("Reply interrupted by server restart"))
    .toBeVisible();
  await expect
    .element(page.getByRole("region", { name: "Messages held after restart" }))
    .toBeVisible();
  expect(
    document.querySelectorAll('.chat-message[data-role="user"]'),
  ).toHaveLength(2);
  expect(document.querySelectorAll(".chat-held-message")).toHaveLength(1);
  const held = document.querySelector<HTMLElement>(".chat-held-message")!;
  expect(held.getBoundingClientRect().width).toBeLessThanOrEqual(320);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(onContinue).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Use as draft" }).click();
  expect(restore).toHaveBeenCalledWith("Old cancelled request");
  await page.getByRole("button", { name: "Edit queued message" }).click();
  await page
    .getByRole("textbox", { name: "Edit queued message" })
    .fill("Make 4k");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Edit queued message" }))
    .toHaveValue("Make 4k");
  allowEdit = true;
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .element(page.getByRole("textbox", { name: "Edit queued message" }))
    .not.toBeInTheDocument();
  await expect
    .element(page.getByText("Make 4k", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "Remove queued message" }).click();
  await expect
    .element(page.getByRole("region", { name: "Messages held after restart" }))
    .not.toBeInTheDocument();
  expect(updates.at(-1)).toEqual({ action: "remove", requestId: "queued" });
});

it("resumes a held message and disables recovery controls during submission", async () => {
  const onUpdate = vi.fn(async (_action: ChatQueueAction) => true);

  function Harness() {
    const [busy, setBusy] = useState(false);

    return (
      <ChatHistory
        conversation={initial}
        busy={busy}
        error={null}
        onReply={async () => true}
        onContinue={async () => true}
        onQueueUpdate={async (action) => {
          setBusy(true);

          return onUpdate(action);
        }}
      />
    );
  }

  await using _screen = await render(<Harness />);
  await page.getByRole("button", { name: "Resume queued message" }).click();
  expect(onUpdate).toHaveBeenCalledWith({
    action: "resume",
    requestId: "queued",
  });
  await expect
    .element(page.getByRole("button", { name: "Resume queued message" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Remove queued message" }))
    .toBeDisabled();
  await expect
    .element(page.getByRole("button", { name: "Continue", exact: true }))
    .toBeDisabled();
});
