module.exports = [
  {
    ignores: [
      "node_modules/**",
      ".git/**",
      "images/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        Module: "readonly"
      }
    },
    rules: {
      "no-console": "off"
    }
  }
];
