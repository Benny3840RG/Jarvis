import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["convex/**/*.test.ts"],
    environment: "edge-runtime",
    server: {
      deps: {
        inline: ["@convex-dev/rate-limiter", "@convex-dev/batch-worker"],
      },
    },
  },
});
