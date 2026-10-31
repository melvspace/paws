import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render.tsx";
import { ContextHandoff } from "./ContextHandoff.tsx";

const model = {
  providerId: "codex",
  modelId: "example-model",
  name: "Example Model",
  driver: "codex" as const,
};

it("keeps restoration invisible during processing and after completion", async () => {
  function Harness() {
    const [completed, setCompleted] = useState(false);

    return (
      <>
        <button onClick={() => setCompleted(true)}>Complete restoration</button>
        <ContextHandoff
          handoff={{
            id: "restore",
            beforeMessageId: "message",
            from: [model],
            to: model,
            status: completed ? "completed" : "pending",
          }}
        />
      </>
    );
  }

  await using _screen = await render(<Harness />);
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector(".chat-handoff")).toBeNull();
  await page.getByRole("button", { name: "Complete restoration" }).click();
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
});

it("hides saved same-provider restoration events but exposes failures", async () => {
  await using _screen = await render(
    <>
      <ContextHandoff
        handoff={{
          id: "restore",
          kind: "session-restoration",
          beforeMessageId: "message",
          from: [model, { ...model, providerId: "old-provider" }],
          to: model,
          status: "completed",
        }}
      />
      <ContextHandoff
        handoff={{
          id: "failure",
          beforeMessageId: "message",
          from: [model],
          to: model,
          status: "failed",
        }}
      />
    </>,
  );
  expect(document.querySelector(".chat-handoff")).toBeNull();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("Could not restore conversation context.");
});

it("distinguishes different provider instances offering the same model", async () => {
  await using _screen = await render(
    <ContextHandoff
      pending
      handoff={{
        id: "switch",
        beforeMessageId: "message",
        from: [model],
        to: { ...model, providerId: "other-account" },
        status: "pending",
      }}
    />,
  );
  const status = page.getByRole("status", {
    name: "Context handoff pending",
    exact: true,
  });
  await expect.element(status).toBeVisible();
  expect(status.element().textContent).toContain("codex");
  expect(status.element().textContent).toContain("other-account");
});
