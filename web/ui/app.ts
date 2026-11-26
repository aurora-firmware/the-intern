import { h, render } from "preact";
import { ConnectionBanner, isConnected } from "./components/connection_banner.ts";
import { noDefaultModel } from "./components/no_model_banner.ts";
import { shell } from "./components/shell.ts";
import { connectFeed, type FeedConnection } from "./feed_connection.ts";
import type { NoDefaultModelNotice } from "./feed_hub.ts";
import { parseRoute, type Route } from "./model/routes.ts";
import { BoardPage } from "./pages/board.ts";
import { DeskPage } from "./pages/desk.ts";
import { JobPage } from "./pages/job.ts";
import { MailPage } from "./pages/mail.ts";
import { RolesPage } from "./pages/roles.ts";
import { SchedulesPage } from "./pages/schedules.ts";
import { StatusPage } from "./pages/status.ts";
import { WorkspacesPage } from "./pages/workspaces.ts";

type PageName = Exclude<Route["page"], "unknown">;

/** The headings of the pages until each page's own task adds its content. */
const PAGE_HEADINGS: Record<PageName, string> = {
    board: "Board",
    job: "Job",
    desk: "Front desk",
    roles: "Roles",
    workspaces: "Workspaces",
    schedules: "Schedules",
    mail: "Mail",
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
        route.page === "desk" ? h(DeskPage, { feed }) : null,
        route.page === "roles" ? h(RolesPage, { feed }) : null,
        route.page === "workspaces" ? h(WorkspacesPage, { feed }) : null,
        route.page === "schedules" ? h(SchedulesPage, { feed }) : null,
        route.page === "mail" ? h(MailPage, { feed }) : null,
        route.page === "status" ? h(StatusPage, { feed }) : null,
        route.page === "job" ? h(JobPage, { feed, number: route.number, key: route.number }) : null,
    );
};

let connected = true;
let notice: NoDefaultModelNotice | null = null;
/** `undefined` while the tab connects, `null` when it could not. */
let feed: FeedConnection | null | undefined;

const renderCurrentRoute = () => {
    render(
        h(
            isConnected.Provider,
            { value: connected },
            h(noDefaultModel.Provider, { value: notice }, showRoute(parseRoute(window.location.hash))),
        ),
        document.body,
    );
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
        connection.onNoDefaultModel((value) => {
            notice = value;
            renderCurrentRoute();
        });
        feed = connection;
        renderCurrentRoute();
    },
    (error) => {
        console.error("The tab could not connect to the feed", error);
        feed = null;
        setConnected(false);
    },
);
