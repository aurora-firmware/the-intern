export type Route =
    | { page: "board" }
    | { page: "job"; number: string }
    | { page: "desk" }
    | { page: "roles" }
    | { page: "workspaces" }
    | { page: "status" }
    | { page: "unknown" };

const JOB_PREFIX = "#/jobs/";
const FIXED_PAGES = new Map<string, Route>([
    ["#/desk", { page: "desk" }],
    ["#/roles", { page: "roles" }],
    ["#/workspaces", { page: "workspaces" }],
    ["#/status", { page: "status" }],
]);

export const parseRoute = (hash: string): Route => {
    if (hash === "" || hash === "#" || hash === "#/") {
        return { page: "board" };
    }
    if (hash.startsWith(JOB_PREFIX)) {
        const number = hash.slice(JOB_PREFIX.length);
        return number !== "" && !number.includes("/") ? { page: "job", number } : { page: "unknown" };
    }
    return FIXED_PAGES.get(hash) ?? { page: "unknown" };
};

export const routeHash = (route: Route): string => {
    switch (route.page) {
        case "job":
            return `${JOB_PREFIX}${route.number}`;
        case "desk":
        case "roles":
        case "workspaces":
        case "status":
            return `#/${route.page}`;
        case "board":
        case "unknown":
            return "#/";
    }
};
