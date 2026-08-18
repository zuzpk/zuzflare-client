export type FlareSentinel = { __op: string; [key: string]: any };

/**
 * Create an increment/decrement sentinel for atomic server-side $inc.
 * Example: `doc.update({ score: increment(1) })` or `increment(-5)` for decrement.
 */
export function increment(value: number): FlareSentinel {
    return { __op: 'inc', v: value };
}

/**
 * Create a vector sentinel. Use in queries or writes as `vector("kamran")` or
 * `vector({ contentBase64: "..." }, 'image')`.
 */
export function vector(
    value: string | { contentBase64: string; mime?: string },
    mode: 'text' | 'image' = 'text'
): FlareSentinel {
    return { __op: 'vector', v: value, mode };
}
