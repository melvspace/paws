import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "./lib/atomRegistry.ts";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { routeTree } from "./routeTree.gen.ts";
import "@fontsource-variable/inter";
import "./components/ui/ui.css";
import { initializeTheme } from "./ThemeSelect.tsx";
import "./styles.css";

initializeTheme();

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing app root");
}

createRoot(root).render(
  <StrictMode>
    <RegistryContext.Provider value={appAtomRegistry}>
      <TooltipProvider delay={400}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </RegistryContext.Provider>
  </StrictMode>,
);
