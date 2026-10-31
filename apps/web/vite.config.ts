import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwind from "@tailwindcss/vite";

const proxy = {
  "/api": "http://127.0.0.1:4310",
  "/ws": { target: "ws://127.0.0.1:4310", ws: true },
};

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwind(),
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    proxy,
  },
});
