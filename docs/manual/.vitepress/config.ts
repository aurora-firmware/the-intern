import { defineConfig } from "vitepress";

// Build output and cache stay under the git-ignored .tmp/ folder (paths are relative to docs/manual).
export default defineConfig({
    title: "The Intern",
    description: "User manual for The Intern",
    outDir: "../../.tmp/manual-site",
    cacheDir: "../../.tmp/manual-cache",
    themeConfig: {
        sidebar: [
            { text: "The Intern user manual", link: "/" },
            { text: "Running The Intern", link: "/running_the_intern" },
            { text: "Roles, workspaces and agents sharing a job", link: "/roles_and_agents" },
            { text: "Giving, following and answering jobs", link: "/jobs" },
            { text: "Command reference", link: "/commands" },
        ],
    },
});
