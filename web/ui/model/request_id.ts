const REQUEST_ID_BYTES = 16;

/** A fresh request id for a submission: random bytes from `crypto.getRandomValues`, in hex (ADR-007 decision 8). */
export const requestId = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(REQUEST_ID_BYTES));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
