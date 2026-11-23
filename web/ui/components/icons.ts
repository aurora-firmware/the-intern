/*
 * Lucide's icons as path data, on a 24 by 24 grid drawn with a 2 px round stroke and no fill (ISC licence, see
 * ICONS_LICENSE.txt). No icon package is added. `stop` is Lucide's `square`, written as a path.
 */
export const icon = {
    chevronDown: ["m6 9 6 6 6-6"],
    chevronUp: ["m18 15-6-6-6 6"],
    chevronLeft: ["m15 18-6-6 6-6"],
    chevronRight: ["m9 18 6-6-6-6"],
    alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "M12 9v4", "M12 17h.01"],
    stop: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"],
    send: [
        "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z",
        "m21.854 2.147-10.94 10.939",
    ],
    download: ["M12 15V3", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5"],
    check: ["M20 6 9 17l-5-5"],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof icon;
