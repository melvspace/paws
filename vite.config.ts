import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["apps/**/*.test.ts", "packages/**/*.test.ts"] },
  fmt: {
    printWidth: 80,
    ignorePatterns: ["pnpm-lock.yaml", "**/routeTree.gen.ts"],
  },
});
