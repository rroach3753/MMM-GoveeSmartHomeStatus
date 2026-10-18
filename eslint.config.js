const js = require("@eslint/js");
const { defineConfig } = require("eslint/config");
const globals = require("globals");

module.exports = defineConfig([
  { ignores: ["node_modules/**", ".git/**", "images/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: { ecmaVersion: 2021, sourceType: "script" },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_" }] }
  },
  {
    files: ["node_helper.js", "eslint.config.js", "lib/**/*.js", "tests/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node }
  },
  {
    files: ["MMM-GoveeSmartHomeStatus.js"],
    languageOptions: { globals: { ...globals.browser, Module: "readonly" } }
  }
]);
