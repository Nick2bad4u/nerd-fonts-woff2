import nickTwoBadFourU from "eslint-config-nick2bad4u";

// Re-use the @typescript-eslint plugin reference already loaded by eslint-config-nick2bad4u
// to avoid importing it as a direct (extraneous) dependency.
const tsPlugin = nickTwoBadFourU.configs.all.find(
    (c) => c.plugins?.["@typescript-eslint"]
)?.plugins?.["@typescript-eslint"];

/** @type {import("eslint").Linter.Config[]} */
const config = [
    {
        ignores: ["fonts/original/**", "fonts/woff2/**"],
    },
    // @ts-expect-error - The type definitions for ESLint configs are very loose

    ...nickTwoBadFourU.configs.all,
    {
        // Function declarations are hoisted in JS/TS — forward references are safe.
        // perfectionist/sort-modules requires alphabetical order, which means entry-point
        // functions like `main` will inevitably call helpers declared later in the file.
        // @ts-expect-error - The type definitions for ESLint configs are very loose
        plugins: {
            "@typescript-eslint": tsPlugin,
        },
        rules: {
            "@typescript-eslint/no-use-before-define": [
                "warn",
                { functions: false },
            ],
            "no-use-before-define": ["error", { functions: false }],
        },
    },
    // @ts-expect-error - The type definitions for ESLint configs are very loose
    {
        // This is a CLI tool with no peer dependencies. The rule fires a false-positive
        // for packages that intentionally have no peerDependencies field.
        files: ["package.json"],
        rules: {
            "package-json/require-peerDependencies": "off",
        },
    },
    // @ts-expect-error - The type definitions for ESLint configs are very loose
    {
        // The shared config enables @stylistic/spaced-comment globally, but the
        // rule does not safely handle HTML comment/token shapes and can crash
        // with "Cannot read properties of undefined (reading 'markers')" when
        // linting index.html.
        files: ["**/*.html"],
        rules: {
            "@stylistic/spaced-comment": "off",
        },
    },
    // @ts-expect-error - The type definitions for ESLint configs are very loose
    {
        // Browser assets and Node scripts use JSDoc primarily for editor hints.
        // strict undefined-type/throws enforcement is too noisy for these files.
        files: ["assets/font-index.js", "scripts/**/*.mjs"],
        rules: {
            "jsdoc/match-description": "off",
            "jsdoc/no-blank-blocks": "off",
            "jsdoc/no-undefined-types": "off",
            "jsdoc/require-throws": "off",
        },
    },
    // @ts-expect-error - The type definitions for ESLint configs are very loose
    {
        // This CLI intentionally operates on validated runtime paths.
        files: ["src/cli.ts"],
        rules: {
            "security/detect-non-literal-fs-filename": "off",
        },
    },
];

export default config;
