import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Allow an empty test suite to exit 0; the first real tests land in T-038.
    passWithNoTests: true,
  },
});
