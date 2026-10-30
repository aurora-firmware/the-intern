import { defineConfig } from "vitepress";

// Build output and cache stay under the git-ignored .tmp/ folder (paths are relative to docs/manual).
export default defineConfig({
    title: "The Intern",
    description: "User manual for The Intern",
    outDir: "../../.tmp/manual-site",
    cacheDir: "../../.tmp/manual-cache",
});
