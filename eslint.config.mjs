import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "temp/**",
            ".cache/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.strict,
    ...tseslint.configs.strictTypeChecked,
    {
        files: ["**/*.{ts,mts,cts,tsx}"],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "@typescript-eslint/consistent-type-definitions": ["error", "type"],
            "@typescript-eslint/no-confusing-void-expression": "error",
            "@typescript-eslint/no-unnecessary-condition": "error",
            "@typescript-eslint/no-unnecessary-template-expression": "error",
            "@typescript-eslint/restrict-template-expressions": [
                "error",
                {
                    allowAny: false,
                    allowBoolean: true,
                    allowNullish: false,
                    allowNumber: true,
                    allowRegExp: false,
                },
            ],
        },
    },
    {
        files: ["test/**/*.ts"],
        rules: {
            "@typescript-eslint/no-floating-promises": "off",
        },
    },
    {
        ...tseslint.configs.disableTypeChecked,
        files: ["**/*.{js,mjs,cjs}"],
    },
    {
        files: ["**/*.{js,mjs,cjs}"],
        languageOptions: {
            ecmaVersion: "latest",
            globals: {
                ...globals.node,
            },
            sourceType: "module",
        },
        rules: {
            "no-console": "off",
        },
    },
];
