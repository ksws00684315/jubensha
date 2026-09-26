import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.int.test.ts"],
    // 共享一个库，串行执行避免 TRUNCATE 互踩
    pool: "forks",
    fileParallelism: false,
    globalSetup: "src/test/int-setup.ts",
    environment: "node",
    testTimeout: 30_000,
  },
});
