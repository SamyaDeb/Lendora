// Shared ESLint flat config for every TypeScript package (Phase 2 quality bar: `pnpm -r lint`).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-live/**",
      "**/e2e/.report/**",
      "**/e2e/.results/**",
      "**/.ponder/**",
      "**/generated/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "client/**",
      "contracts/**",
      "sim/**",
      "packages/sdk/src/abis.ts",
      "**/ponder-env.d.ts",
      "packages/sdk/src/api/schema.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {globals: {...globals.node, ...globals.browser}},
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none"}],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
