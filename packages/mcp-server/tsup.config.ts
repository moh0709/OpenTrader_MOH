import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "./src/cli.ts" },
  format: ["esm"],
  outDir: "dist",
  clean: true,
  bundle: true,
  target: "node22",
  // Bundled so the server can be launched from anywhere on the host without a
  // node_modules tree next to it.
  noExternal: [/@modelcontextprotocol/, /zod/],
  outExtension: () => ({ js: ".mjs" }),
  banner: { js: "#!/usr/bin/env node" },
});
