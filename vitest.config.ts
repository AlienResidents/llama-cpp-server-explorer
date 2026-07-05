import { defineConfig } from "vitest/config";

// Minimal config — vitest auto-discovers **/*.test.ts. We constrain it to
// server/src/ so client tests (if added later) can have their own config.
export default defineConfig({
  test: {
    include: ["server/src/**/*.test.ts"],
    // Each test file runs in its own module registry so DB_PATH env var
    // overrides don't leak between files. Within a file, tests use
    // vi.resetModules() + dynamic import() to re-trigger migrations.
    pool: "forks",
    // Close better-sqlite3 handles promptly after each test file.
    isolate: true,
  },
});
