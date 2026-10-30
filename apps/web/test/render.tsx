import { act as reactAct, type ReactNode } from "react";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "../src/lib/atomRegistry.ts";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../src/components/ui/tooltip.tsx";
import "../src/styles.css";
import "../src/components/ui/ui.css";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

async function act(callback: () => void) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  try {
    await reactAct(callback);
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

export async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <TooltipProvider>{node}</TooltipProvider>
      </RegistryContext.Provider>,
    ),
  );

  return {
    async [Symbol.asyncDispose]() {
      await act(() => root.unmount());
      container.remove();
    },
  };
}
