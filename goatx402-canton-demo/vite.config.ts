import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the goat-canton-payment client-web SPA (PLAN.md Task 13).
// The same bundle is exercised by `pnpm dev`, `pnpm preview`, and the Playwright
// suite (which runs against `pnpm preview` per §8.3 E2 / Task 13 wording).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.spec.ts", "tests/**/*.spec.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    css: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "**/*.d.ts"],
    },
  },
});
