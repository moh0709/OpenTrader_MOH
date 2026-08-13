import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The pure parts of the dashboard - formatting and the ticker's mapping -
    // are plain modules with no DOM, so they test in node. Anything that
    // touches the document is verified in a real browser instead, which is
    // the only place its layout and animation are actually true.
    environment: "node",
    include: ["lib/**/*.test.js"],
  },
});
