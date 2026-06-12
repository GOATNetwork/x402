import { defineConfig } from "vitest/config";

// Vitest config. We only need to point at the __tests__ directory and
// allow the test runner to import the ESM source directly (vitest does
// this by default via its own transformer).
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
