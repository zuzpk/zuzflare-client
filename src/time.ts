export type FlareTimestampInput =
    | Date
    | string
    | number
    | { $date?: string | number | { $numberLong?: string } }
    | null
    | undefined;

const DEFAULT_DOC_TIME_FIELDS = [
    "updatedAt",
    "createdAt",
    "_updatedAt",
    "_createdAt",
] as const;

export const toDate = (value: FlareTimestampInput): Date | null => {
    if (value == null) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value === "number") {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    if (typeof value === "string") {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    if (typeof value === "object" && "$date" in value) {
        const inner = (value as { $date?: string | number | { $numberLong?: string } }).$date;
        if (typeof inner === "string" || typeof inner === "number") {
            const d = new Date(inner);
            return Number.isNaN(d.getTime()) ? null : d;
        }
        if (inner && typeof inner === "object" && typeof inner.$numberLong === "string") {
            const ms = Number(inner.$numberLong);
            if (!Number.isFinite(ms)) return null;
            const d = new Date(ms);
            return Number.isNaN(d.getTime()) ? null : d;
        }
    }

    return null;
};

export const getDocumentTimestamp = (
    doc: Record<string, unknown> | null | undefined,
    field: string = "updatedAt",
): Date | null => {
    if (!doc) return null;

    const candidates = field
        ? [field, ...DEFAULT_DOC_TIME_FIELDS.filter((f) => f !== field)]
        : [...DEFAULT_DOC_TIME_FIELDS];

    for (const key of candidates) {
        const value = doc[key as keyof typeof doc] as FlareTimestampInput;
        const parsed = toDate(value);
        if (parsed) return parsed;
    }

    return null;
};

export const formatLocalDateTime = (
    value: FlareTimestampInput,
    options?: Intl.DateTimeFormatOptions,
    locale?: string,
): string => {
    const date = toDate(value);
    if (!date) return "";

    return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        ...options,
    }).format(date);
};

export const diffMs = (a: FlareTimestampInput, b: FlareTimestampInput = new Date()): number | null => {
    const da = toDate(a);
    const db = toDate(b);
    if (!da || !db) return null;
    return da.getTime() - db.getTime();
};

export const timeAgo = (
    value: FlareTimestampInput,
    now: FlareTimestampInput = new Date(),
): string => {
    const delta = diffMs(value, now);
    if (delta == null) return "";

    const abs = Math.abs(delta);
    const mins = Math.floor(abs / 60_000);
    const hours = Math.floor(abs / 3_600_000);
    const days = Math.floor(abs / 86_400_000);

    if (abs < 30_000) return "just now";
    if (mins < 60) return delta < 0 ? `${mins}m ago` : `in ${mins}m`;
    if (hours < 24) return delta < 0 ? `${hours}h ago` : `in ${hours}h`;
    return delta < 0 ? `${days}d ago` : `in ${days}d`;
};
