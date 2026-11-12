import { defineConfig } from "vitest/config";

// Unit tests need no network and no Docker. The Testcontainers tests live in tests/integration and run with
// "npm run test:integration" (vitest.integration.config.ts).
// One worker, one file at a time: the suite stays light on the CPU of a development laptop.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    maxWorkers: 1,
    fileParallelism: false,
    reporters: ["default", "junit"],
    outputFile: { junit: "reports/junit.xml" },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Excluded: the composition root, interface-only files and the NATS connection loop, which needs a real broker
      // (covered by the integration tests; the message rules it applies are unit-tested in message-handlers.ts).
      exclude: ["src/main.ts", "src/usecases/ports.ts", "src/usecases/use-cases.ts", "src/adapters/nats/jetstream-consumer.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: { lines: 80, functions: 80, statements: 80 },
    },
  },
});
