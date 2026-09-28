/** Joins class names, skipping falsy values. */
export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
