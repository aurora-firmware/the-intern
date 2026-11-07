import { defineConfig } from "vitepress";

// Build output and cache stay under the git-ignored .tmp/ folder (paths are relative to docs/manual).
export default defineConfig({
    title: "The Intern",
    description: "User manual for The Intern",
    // GitHub Pages serves this project's site under /the-intern/, not at the domain root.
    base: "/the-intern/",
    outDir: "../../.tmp/manual-site",
    cacheDir: "../../.tmp/manual-cache",
    themeConfig: {
        sidebar: [
            { text: "The Intern user manual", link: "/" },
            { text: "Running The Intern", link: "/running_the_intern" },
            { text: "Roles, workspaces and agents sharing a job", link: "/roles_and_agents" },
            { text: "Giving, following and answering jobs", link: "/jobs" },
            { text: "The front desk and bob chat", link: "/front_desk" },
            { text: "The web interface", link: "/web_interface" },
            { text: "Command reference", link: "/commands" },
        ],
    },
});
