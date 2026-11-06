import { h, render } from "preact";
import { ConnectionBanner, isConnected } from "./components/connection_banner.ts";
import { shell } from "./components/shell.ts";
import { connectFeed, type FeedConnection } from "./feed_connection.ts";
import { parseRoute, type Route } from "./model/routes.ts";
import { BoardPage } from "./pages/board.ts";
import { JobPage } from "./pages/job.ts";

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
        page === "board" ? h(BoardPage, { feed }) : null,
        route.page === "job" ? h(JobPage, { feed, number: route.number, key: route.number }) : null,
    );
};

let connected = true;
/** `undefined` while the tab connects, `null` when it could not. */
let feed: FeedConnection | null | undefined;

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
    (connection) => {
        connection.onConnection(setConnected);
        feed = connection;
        renderCurrentRoute();
    },
    (error) => {
        console.error("The tab could not connect to the feed", error);
        feed = null;
        setConnected(false);
    },
);
