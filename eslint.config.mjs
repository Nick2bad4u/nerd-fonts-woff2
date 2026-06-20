import nickTwoBadFourU from "eslint-config-nick2bad4u";

// Re-use the @typescript-eslint plugin reference already loaded by eslint-config-nick2bad4u
// to avoid importing it as a direct (extraneous) dependency.
const maybeTsPlugin = nickTwoBadFourU.configs.all.find(
    (c) => c.plugins?.["@typescript-eslint"]
)?.plugins?.["@typescript-eslint"];

if (!maybeTsPlugin) {
    throw new Error("Unable to load @typescript-eslint from shared config.");
}

const tsPlugin = maybeTsPlugin;

/** @type {import("eslint").ESLint.Plugin} */
const htmlCompatibilityPlugin = {
    rules: {
        indent: {
            create: () => ({}),
            meta: {
                schema: [],
                type: "layout",
            },
        },
    },
};

/** @type {import("eslint").Linter.Config[]} */
const config = [
    {
        ignores: ["fonts/original/**", "fonts/woff2/**"],
    },

    ...nickTwoBadFourU.configs.all,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        "*.{js,mjs,cjs}",
                        ".*.{js,mjs,cjs}",
                        "assets/font-index.js",
                    ],
                    maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 16,
                },
            },
        },
    },
    {
        // Function declarations are hoisted in JS/TS — forward references are safe.
        // perfectionist/sort-modules requires alphabetical order, which means entry-point
        // functions like `main` will inevitably call helpers declared later in the file.
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
    {
        // This is a CLI tool with no peer dependencies. The rule fires a false-positive
        // for packages that intentionally have no peerDependencies field.
        files: ["package.json"],
        rules: {
            "package-json/require-peerDependencies": "off",
        },
    },
    {
        // The shared config enables @stylistic/spaced-comment globally, but the
        // rule does not safely handle HTML comment/token shapes and can crash
        // with "Cannot read properties of undefined (reading 'markers')" when
        // linting index.html.
        files: ["**/*.html"],
        plugins: {
            html: htmlCompatibilityPlugin,
        },
        rules: {
            "@html-eslint/element-newline": "off",
            "@html-eslint/no-extra-spacing-tags": "off",
            "@stylistic/spaced-comment": "off",
            "html/indent": "off",
        },
    },
    {
        // Browser assets and Node scripts use JSDoc primarily for editor hints.
        // strict undefined-type/throws enforcement is too noisy for these files.
        files: ["assets/font-index.js", "scripts/**/*.mjs"],
        rules: {
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/restrict-template-expressions": "off",
            "jsdoc/match-description": "off",
            "jsdoc/no-blank-blocks": "off",
            "jsdoc/no-undefined-types": "off",
            "jsdoc/require-throws": "off",
            "listeners/no-inline-function-event-listener": "off",
            "listeners/no-missing-remove-event-listener": "off",
            "n/no-unsupported-features/node-builtins": "off",
            "perfectionist/sort-modules": "off",
            "promise/always-return": "off",
            "regexp/no-super-linear-move": "off",
            "regexp/require-unicode-sets-regexp": "off",
            "regexp/sort-character-class-elements": "off",
            "unicorn/consistent-boolean-name": "off",
            "unicorn/consistent-existence-index-check": "off",
            "unicorn/no-array-sort": "off",
            "unicorn/no-top-level-assignment-in-function": "off",
            "unicorn/no-unnecessary-global-this": "off",
            "unicorn/no-unreadable-for-of-expression": "off",
            "unicorn/prefer-await": "off",
            "unicorn/prefer-direct-iteration": "off",
            "unicorn/prefer-iterator-to-array": "off",
            "unicorn/prefer-query-selector": "off",
        },
    },
    {
        // This CLI intentionally operates on validated runtime paths.
        files: ["src/cli.ts"],
        rules: {
            "runtime-cleanup/no-floating-child-processes": "off",
            "security/detect-non-literal-fs-filename": "off",
            "unicorn/consistent-boolean-name": "off",
            "unicorn/consistent-conditional-object-spread": "off",
            "unicorn/no-array-front-mutation": "off",
            "unicorn/no-break-in-nested-loop": "off",
            "unicorn/no-declarations-before-early-exit": "off",
            "unicorn/prefer-includes-over-repeated-comparisons": "off",
            "unicorn/prefer-number-coercion": "off",
            "unicorn/prefer-ternary": "off",
            "unicorn/prefer-unicode-code-point-escapes": "off",
        },
    },
    {
        // The CLI test suite intentionally exercises many argument/error cases in one
        // harness so shared setup stays visible. Keep assertion policy focused here.
        files: ["test/**/*.ts"],
        rules: {
            "max-lines-per-function": "off",
            "test-signal/no-weak-existence-assertions": "off",
            "test-signal/no-weak-truthy-assertions": "off",
            "unicorn/consistent-boolean-name": "off",
            "unicorn/prefer-string-repeat": "off",
            "vitest/prefer-strict-boolean-matchers": "off",
        },
    },
];

export default config;
