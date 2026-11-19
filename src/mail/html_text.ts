const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

const decodeEntity = (entity: string, body: string): string => {
    if (body.startsWith("#")) {
        const isHex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
};

/** Plain text of an HTML message part: no script or style content, block ends as line breaks, entities decoded. */
export const htmlToText = (html: string): string =>
    html
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<br\b[^>]*>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, decodeEntity)
        .replace(/\n{3,}/g, "\n\n")
        .trim();
