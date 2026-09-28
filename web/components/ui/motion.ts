/** Shared motion settings (tokens.css --ease-*, --dur-*), for Motion's JS API. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const; // landing reveal
export const EASE_INOUT = [0.7, 0, 0.2, 1] as const; // landing ticker

export const DUR = {fast: 0.15, base: 0.2, num: 0.4, session: 0.6} as const;

export const fade = {initial: {opacity: 0}, animate: {opacity: 1}, exit: {opacity: 0}, transition: {duration: DUR.base, ease: EASE_OUT}};
