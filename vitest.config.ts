import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/**/src/**/*.test.ts"],
    // Most test files start real-time engines, several at once in the game and network tests. Running every file in
    // parallel starves them all on any machine, so keep a quarter of the cores busy with files at a time.
    maxWorkers: "25%",
  },
});
