// Vitest setup file — register testing-library matchers and patch the global
// fetch to throw if a test forgets to mock it (so we never accidentally
// silently call the real network in CI).
import "@testing-library/jest-dom/vitest";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
