import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMessage } from "./mime.ts";

const FOLDER_MODE = 0o700;
const FILE_MODE = 0o600;
const UNNAMED_ATTACHMENT = "attachment";

export type SavedCopyPaths = { directory: string; message: string; text: string; attachments: string[] };

// Path separators and control characters would let a name leave `attachments/` or break a file listing.
const isUnsafeCharacter = (character: string): boolean => {
    const code = character.charCodeAt(0);
    return character === "/" || character === "\\" || code <= 0x1f || code === 0x7f;
};

const safeName = (name: string | null): string => {
    const cleaned = [...(name ?? "")].filter((character) => !isUnsafeCharacter(character)).join("");
    return cleaned === "" ? UNNAMED_ATTACHMENT : cleaned;
};

const attachmentFileName = (index: number, name: string | null): string => `${index + 1}-${safeName(name)}`;

// The number keeps two attachments of one name apart; it counts from 1.
export const savedCopyPaths = (
    mailDir: string,
    savedId: string,
    attachmentNames: readonly (string | null)[],
): SavedCopyPaths => {
    const directory = join(mailDir, savedId);
    return {
        directory,
        message: join(directory, "message.eml"),
        text: join(directory, "message.txt"),
        attachments: attachmentNames.map((name, index) =>
            join(directory, "attachments", attachmentFileName(index, name)),
        ),
    };
};

export const hasSavedCopy = async (mailDir: string, savedId: string): Promise<boolean> => {
    try {
        return (await stat(join(mailDir, savedId))).isDirectory();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return false;
        }
        throw error;
    }
};

// The copy is built in a temporary folder next to its final place and renamed into it, so a crash leaves no half copy.
// The daemon never reads the copy back: the job store holds the raw bytes (ADR-011).
export const writeSavedCopy = async (mailDir: string, savedId: string, raw: Uint8Array): Promise<void> => {
    const parsed = await parseMessage(raw);
    const paths = savedCopyPaths(
        mailDir,
        savedId,
        parsed.attachments.map((attachment) => attachment.filename),
    );
    await mkdir(mailDir, { recursive: true, mode: FOLDER_MODE });
    const staging = await mkdtemp(join(mailDir, `.${savedId}.`));
    try {
        await mkdir(join(staging, "attachments"), { mode: FOLDER_MODE });
        await writeFile(join(staging, "message.eml"), raw, { mode: FILE_MODE });
        await writeFile(join(staging, "message.txt"), parsed.text, { mode: FILE_MODE });
        for (const [index, attachment] of parsed.attachments.entries()) {
            const file = join(staging, "attachments", attachmentFileName(index, attachment.filename));
            await writeFile(file, attachment.content, { mode: FILE_MODE });
        }
        await rm(paths.directory, { recursive: true, force: true });
        await rename(staging, paths.directory);
    } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
    }
};
