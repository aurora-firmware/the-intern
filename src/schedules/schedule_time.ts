// Cron reading and due times for schedule entries (S-007 REQ-005). Pure: no clock, no I/O.

export class CronError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CronError";
    }
}

export interface CronExpression {
    readonly minutes: readonly number[];
    readonly hours: readonly number[];
    readonly daysOfMonth: ReadonlySet<number>;
    readonly months: ReadonlySet<number>;
    readonly daysOfWeek: ReadonlySet<number>;
    readonly isDayOfMonthRestricted: boolean;
    readonly isDayOfWeekRestricted: boolean;
}

interface FieldSpec {
    readonly name: string;
    readonly min: number;
    readonly max: number;
}

const MINUTE: FieldSpec = { name: "minute", min: 0, max: 59 };
const HOUR: FieldSpec = { name: "hour", min: 0, max: 23 };
const DAY_OF_MONTH: FieldSpec = { name: "day of month", min: 1, max: 31 };
const MONTH: FieldSpec = { name: "month", min: 1, max: 12 };
const DAY_OF_WEEK: FieldSpec = { name: "day of week", min: 0, max: 7 };

// The longest gap between two 29 Februaries.
const SEARCH_YEARS = 8;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const readNumber = (text: string, field: FieldSpec): number => {
    if (!/^\d+$/.test(text)) {
        throw new CronError(`The ${field.name} field has "${text}", which isn't a number, a range or "*".`);
    }
    const value = Number(text);
    if (value < field.min || value > field.max) {
        throw new CronError(`The ${field.name} field has ${value}, outside ${field.min} to ${field.max}.`);
    }
    return value;
};

const readStep = (text: string, field: FieldSpec): number => {
    if (!/^\d+$/.test(text) || Number(text) < 1) {
        throw new CronError(`The ${field.name} field has the step "${text}", which must be a whole number from 1.`);
    }
    return Number(text);
};

const readItem = (item: string, field: FieldSpec): number[] => {
    const [base = "", step, ...extra] = item.split("/");
    if (extra.length > 0) {
        throw new CronError(`The ${field.name} field has "${item}", which has more than one step.`);
    }
    let from: number;
    let to: number;
    if (base === "*") {
        from = field.min;
        to = field === DAY_OF_WEEK ? 6 : field.max;
    } else if (base.includes("-")) {
        const [low = "", high = "", ...more] = base.split("-");
        if (more.length > 0) {
            throw new CronError(`The ${field.name} field has "${item}", which isn't a range.`);
        }
        from = readNumber(low, field);
        to = readNumber(high, field);
        if (from > to) {
            throw new CronError(`The ${field.name} field has the range "${base}", which must run upward.`);
        }
    } else {
        if (step !== undefined) {
            throw new CronError(`The ${field.name} field has "${item}": a step goes only on "*" or a range.`);
        }
        return [readNumber(base, field)];
    }
    const size = step === undefined ? 1 : readStep(step, field);
    const values: number[] = [];
    for (let value = from; value <= to; value += size) {
        values.push(value);
    }
    return values;
};

const readField = (text: string, field: FieldSpec): number[] => {
    const values = text.split(",").flatMap((item) => readItem(item, field));
    return [...new Set(values)].sort((a, b) => a - b);
};

const isRestricted = (values: ReadonlySet<number>, field: FieldSpec): boolean =>
    values.size < field.max - field.min + 1;

const canMeet = (months: ReadonlySet<number>, daysOfMonth: ReadonlySet<number>): boolean =>
    [...months].some((month) => [...daysOfMonth].some((day) => day <= (DAYS_IN_MONTH[month - 1] as number)));

export const parseCron = (text: string): CronExpression => {
    const fields = text.trim().split(/ +/);
    if (fields.length !== 5) {
        throw new CronError(`A cron expression has exactly five fields, and "${text}" has ${fields.length}.`);
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
    const daysOfWeek = new Set(readField(dayOfWeek, DAY_OF_WEEK).map((day) => day % 7));
    const daysOfMonth = new Set(readField(dayOfMonth, DAY_OF_MONTH));
    const months = new Set(readField(month, MONTH));
    const cron: CronExpression = {
        minutes: readField(minute, MINUTE),
        hours: readField(hour, HOUR),
        daysOfMonth,
        months,
        daysOfWeek,
        isDayOfMonthRestricted: isRestricted(daysOfMonth, DAY_OF_MONTH),
        isDayOfWeekRestricted: daysOfWeek.size < 7,
    };
    if (!cron.isDayOfWeekRestricted && !canMeet(months, daysOfMonth)) {
        throw new CronError(`"${text}" is never due: its month and day of month never meet.`);
    }
    return cron;
};

const isDayDue = (cron: CronExpression, date: Date): boolean => {
    if (!cron.months.has(date.getMonth() + 1)) {
        return false;
    }
    const byMonthDay = cron.daysOfMonth.has(date.getDate());
    const byWeekDay = cron.daysOfWeek.has(date.getDay());
    if (cron.isDayOfMonthRestricted && cron.isDayOfWeekRestricted) {
        return byMonthDay || byWeekDay;
    }
    return byMonthDay && byWeekDay;
};

// The earliest due time after `after`, passing over local times that don't exist and counting a repeated one once.
export const nextDueTime = (cron: CronExpression, after: Date): Date => {
    const start = new Date(after.getFullYear(), after.getMonth(), after.getDate() - 1);
    const end = new Date(start.getFullYear() + SEARCH_YEARS, start.getMonth(), start.getDate() + 2);
    for (let day = start; day < end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
        if (!isDayDue(cron, day)) {
            continue;
        }
        for (const hour of cron.hours) {
            for (const minute of cron.minutes) {
                const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
                const exists = candidate.getHours() === hour && candidate.getMinutes() === minute;
                if (exists && candidate.getTime() > after.getTime()) {
                    return candidate;
                }
            }
        }
    }
    throw new CronError(`The expression has no due time within ${SEARCH_YEARS} years after ${after.toISOString()}.`);
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export const localTimeText = (at: Date): string => {
    const offset = -at.getTimezoneOffset();
    const sign = offset < 0 ? "-" : "+";
    const absolute = Math.abs(offset);
    const date = `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
    return `${date}T${time}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};
