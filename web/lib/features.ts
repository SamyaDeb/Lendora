/**
 * Feature flags (NEXT_PUBLIC_*, inlined at build). Both are off by default: the delta-neutral vault is Phase 4 (08)
 * and the backstop pool Phase 5 (09 §2); neither has contracts yet, so their screens run on labelled preview data.
 */
export const FEATURES = {
  vault: process.env.NEXT_PUBLIC_FEATURE_VAULT === "1",
  backstop: process.env.NEXT_PUBLIC_FEATURE_BACKSTOP === "1",
} as const;
