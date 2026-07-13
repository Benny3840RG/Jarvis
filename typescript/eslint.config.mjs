import js from "@eslint/js";
import convexPlugin from "@convex-dev/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      "convex/_generated/**",
      ".agents/**",
      ".claude/**",
      "backups/**",
      "data/**",
    ],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "convex/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  ...convexPlugin.configs.recommended,
]);
