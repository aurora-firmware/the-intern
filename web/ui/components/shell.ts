import { type ComponentChildren, Fragment, h } from "preact";

export type ShellPage = "board" | "desk" | "roles" | "workspaces" | "status" | "job";

const LINKS: { page: ShellPage; label: string; href: string }[] = [
    { page: "board", label: "Board", href: "#/" },
    { page: "desk", label: "Front desk", href: "#/desk" },
    { page: "roles", label: "Roles", href: "#/roles" },
    { page: "workspaces", label: "Workspaces", href: "#/workspaces" },
    { page: "status", label: "Status", href: "#/status" },
];

export type ShellProps = {
    /** The page being shown; its sidebar link is marked active. The Job page has no link. */
    active: ShellPage;
    children?: ComponentChildren;
};

/** The frame every page sits in, as two siblings of the flex body: the Dark Blue sidebar with the white logo and the page links, and the content area. */
export const shell = ({ active, children }: ShellProps) =>
    h(
        Fragment,
        null,
        h(
            "nav",
            { class: "sidebar" },
            h("img", {
                src: "assets/brand/logo.svg",
                alt: "Aurora Firmware",
                width: 96,
                height: 96,
                style: "margin: 0 1.5rem 1rem",
            }),
            h("div", { class: "app-title" }, "The Intern"),
            ...LINKS.map((link) =>
                h("a", { href: link.href, "aria-current": link.page === active ? "page" : undefined }, link.label),
            ),
        ),
        h("main", null, children),
    );
