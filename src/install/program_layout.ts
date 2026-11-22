/**
 * The program folder every installed version shares (ADR-013 decisions 1 and 2): its paths, the layout refusals, and
 * the atomic switch of the `current` and `previous` links. The order of switching belongs to the commands; this module
 * only makes each switch atomic. It imports only Node modules and the pure installation model.
 */
import { chmod, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseVersion } from "./install_model.ts";

const OWNER_ONLY_DIR_MODE = 0o700;
const NODE_MODULES_SEGMENT = "node_modules";
const TEMPORARY_LINK_PREFIX = ".link-";

export type LinkName = "current" | "previous";

export type ProgramLayout = {
    root: string;
    versionsDir: string;
    versionDir: (version: string) => string;
    current: string;
    previous: string;
    serviceRecord: string;
    holdFile: string;
    installLock: string;
    journal: string;
    bobLink: string;
};

/** The layout is unusable, or an operation on it is refused. The message names the path and says why. */
export class ProgramLayoutError extends Error {
    path: string;

    constructor(path: string, reason: string) {
        super(`Program folder ${path}: ${reason}`);
        this.name = "ProgramLayoutError";
        this.path = path;
    }
}

export function programLayout(homeDir: string): ProgramLayout {
    const root = join(homeDir, ".local", "lib", "the-intern");
    const versionsDir = join(root, "versions");
    return {
        root,
        versionsDir,
        versionDir: (version) => join(versionsDir, version),
        current: join(root, "current"),
        previous: join(root, "previous"),
        serviceRecord: join(root, "service.json"),
        holdFile: join(root, "service.hold"),
        installLock: join(root, "install.lock"),
        journal: join(root, "operation.json"),
        bobLink: join(homeDir, ".local", "bin", "bob"),
    };
}

function isInside(inner: string, outer: string): boolean {
    const path = relative(outer, inner);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Refuses a `node_modules` segment, and a program folder that lies inside an instance directory or holds one. */
export function checkLayout(layout: ProgramLayout, instanceDirs: readonly string[]): void {
    const root = resolve(layout.root);
    if (root.split(sep).includes(NODE_MODULES_SEGMENT)) {
        throw new ProgramLayoutError(
            root,
            `the path holds a ${NODE_MODULES_SEGMENT} segment, where Node won't strip types; use another home`,
        );
    }
    for (const instanceDir of instanceDirs) {
        const dir = resolve(instanceDir);
        if (isInside(root, dir)) {
            throw new ProgramLayoutError(root, `it lies inside the instance directory ${dir}; keep them apart`);
        }
        if (isInside(dir, root)) {
            throw new ProgramLayoutError(root, `it holds the instance directory ${dir}; keep them apart`);
        }
    }
}

function requireVersion(layout: ProgramLayout, version: string): void {
    if (parseVersion(version) === undefined) {
        throw new ProgramLayoutError(layout.root, `"${version}" is not a version of the form X.Y.Z`);
    }
}

/** The version the link names, or null when the link does not exist. */
export async function readLink(layout: ProgramLayout, which: LinkName): Promise<string | null> {
    let target: string;
    try {
        target = await readlink(layout[which]);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const prefix = `versions${sep}`;
    if (!target.startsWith(prefix) || parseVersion(target.slice(prefix.length)) === undefined) {
        throw new ProgramLayoutError(layout[which], `the link names ${target}, not a version folder`);
    }
    return target.slice(prefix.length);
}

async function ensureRoot(layout: ProgramLayout): Promise<void> {
    await mkdir(layout.root, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await chmod(layout.root, OWNER_ONLY_DIR_MODE);
}

/** Points the link at the version by creating a new relative link beside it and renaming it over the old one. */
export async function switchLink(layout: ProgramLayout, which: LinkName, version: string | null): Promise<void> {
    if (version === null) {
        await rm(layout[which], { force: true });
        return;
    }
    requireVersion(layout, version);
    await ensureRoot(layout);
    const temporary = join(layout.root, `${TEMPORARY_LINK_PREFIX}${process.pid}-${which}`);
    await rm(temporary, { force: true });
    await symlink(join("versions", version), temporary);
    try {
        await rename(temporary, layout[which]);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

/** Removes a version folder, refusing while `current` or `previous` names it. */
export async function removeVersion(layout: ProgramLayout, version: string): Promise<void> {
    requireVersion(layout, version);
    for (const which of ["current", "previous"] as const) {
        if ((await readLink(layout, which)) === version) {
            throw new ProgramLayoutError(layout.versionDir(version), `${which} still names version ${version}`);
        }
    }
    await rm(layout.versionDir(version), { recursive: true, force: true });
}
