import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { Conversation, SendChat } from "@paws/contracts";
import { render } from "../../test/render.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { SecretRequestForm } from "./SecretRequestForm.tsx";

it("masks secrets and replaces the private form with a status, without a user message", async () => {
  const replies: NonNullable<SendChat["reply"]>[] = [];

  function Harness() {
    const [conversation, setConversation] = useState<Conversation>({
      agentId: "agent",
      revision: 1,
      status: "idle",
      error: null,
      selection: null,
      messages: [
        {
          id: "secret",
          role: "assistant",
          text: "Connect the service.",
          createdAt: "2026-01-01",
          card: {
            text: "Connect the service.",
            fields: [],
            actions: [],
            secretRequest: { label: "Service token" },
          },
        },
      ],
    });

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
              interaction: {
                source: "paws",
                type: "secret_saved",
                eventId: "event",
                messageId: message.id,
                prompt: message.text,
                action: { id: "save", label: "Service token" },
                fields: [],
              },
            })),
          });

          return true;
        }}
      />
    );
  }

  await using _screen = await render(<Harness />);
  const input = page.getByLabelText("Service token", { exact: true });
  await expect.element(input).toHaveAttribute("type", "password");
  await expect
    .element(page.getByRole("button", { name: "Save securely" }))
    .toBeDisabled();
  await input.fill("test-token");
  await page.getByRole("button", { name: "Save securely" }).click();
  expect(replies).toEqual([
    { messageId: "secret", actionId: "save", values: {}, secret: "test-token" },
  ]);
  await expect
    .element(page.getByText("Secret provided securely"))
    .toBeVisible();
  await expect.element(input).not.toBeInTheDocument();
  expect(
    document.querySelectorAll('.chat-message[data-role="user"]'),
  ).toHaveLength(0);
  expect(document.body.textContent).not.toContain("test-token");
});

it("declines without sending a partially entered secret", async () => {
  const replies: NonNullable<SendChat["reply"]>[] = [];
  await using _screen = await render(
    <SecretRequestForm
      messageId="secret"
      label="Token"
      disabled={false}
      onReply={async (reply) => {
        replies.push(reply);

        return true;
      }}
    />,
  );
  await page.getByLabelText("Token", { exact: true }).fill("not-submitted");
  await page.getByRole("button", { name: "Decline" }).click();
  expect(replies).toEqual([
    { messageId: "secret", actionId: "decline", values: {} },
  ]);
  await expect
    .element(page.getByLabelText("Token", { exact: true }))
    .toHaveValue("");
});
