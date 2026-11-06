import { h, render } from "preact";
import { shell } from "./components/shell.ts";
import { parseRoute, type Route } from "./model/routes.ts";

type PageName = Exclude<Route["page"], "unknown">;

/** The headings of the pages until each page's own task adds its content. */
const PAGE_HEADINGS: Record<PageName, string> = {
    board: "Board",
    job: "Job",
    desk: "Front desk",
    roles: "Roles",
    workspaces: "Workspaces",
    status: "Status",
};

const showRoute = (route: Route) => {
    const page: PageName = route.page === "unknown" ? "board" : route.page;
    return h(shell, { active: page }, h("h2", { class: "page-heading" }, PAGE_HEADINGS[page]));
};

const renderCurrentRoute = () => {
    render(showRoute(parseRoute(window.location.hash)), document.body);
};

window.addEventListener("hashchange", renderCurrentRoute);
renderCurrentRoute();
