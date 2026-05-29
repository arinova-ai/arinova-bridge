import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "false/**", ".claude/**", "node_modules/**", "workspace/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        Buffer: "readonly",
        console: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        global: "readonly",
        NodeJS: "readonly",
        process: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
    },
  },
  {
    files: ["tests/**/*.ts", "src/**/__tests__/*.ts"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "require-yield": "off",
    },
  },
);
