import { h, render } from "preact";
import { ConnectionBanner, isConnected } from "./components/connection_banner.ts";
import { shell } from "./components/shell.ts";
import { connectFeed } from "./feed_connection.ts";
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
    return h(
        shell,
        { active: page },
        h(ConnectionBanner, null),
        h("h2", { class: "page-heading" }, PAGE_HEADINGS[page]),
    );
};

let connected = true;

const renderCurrentRoute = () => {
    render(h(isConnected.Provider, { value: connected }, showRoute(parseRoute(window.location.hash))), document.body);
};

const setConnected = (value: boolean) => {
    connected = value;
    renderCurrentRoute();
};

window.addEventListener("hashchange", renderCurrentRoute);
renderCurrentRoute();
connectFeed().then(
    (feed) => feed.onConnection(setConnected),
    (error) => {
        console.error("The tab could not connect to the feed", error);
        setConnected(false);
    },
);
