import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  plugins: [react(), tailwind()],
  optimizeDeps: { include: ["@base-ui/react/menu", "@base-ui/react/select"] },
  test: {
    include: ["src/**/*.browser.test.tsx"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      instances: [{ browser: "chromium" }],
    },
  },
});
