import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../test/render.tsx";
import { AgentDialog } from "./AgentDialog.tsx";

it("opens agent creation when randomUUID is unavailable", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });

  try {
    await using _screen = await render(
      <AgentDialog agent={null} connected embedded onDismiss={() => {}} />,
    );
    await expect
      .element(page.getByRole("textbox", { name: "Name", exact: true }))
      .toBeVisible();
  } finally {
    vi.unstubAllGlobals();
  }
});
