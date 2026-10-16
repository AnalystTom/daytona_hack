import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests run in plain Node without the Cloudflare plugin.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./src/worker/test/cloudflare-workers.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
