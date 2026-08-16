import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The pure parts of the dashboard - formatting and the ticker's mapping -
    // are plain modules with no DOM, so they test in node. Anything that
    // touches the document is verified in a real browser instead, which is
    // the only place its layout and animation are actually true.
    environment: "node",
    // widgets/*.render.test.js is a deliberate exception to the note above:
    // it asserts structure (do the nodes a widget builds actually reach the
    // container) and never appearance, which a shim can check and a browser
    // check would not have caught any earlier.
    include: ["lib/**/*.test.js", "widgets/**/*.test.js"],
  },
});
