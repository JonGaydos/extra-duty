// Local mirror of the SonarCloud JS/TS analysis, run with `npm run lint:sonar`.
// It adds the sonarjs recommended rules and the React, accessibility and
// TypeScript rules SonarCloud reports under its own keys (noted beside each).
// The normal `npm run lint` does not load this file.
import sonarjs from "eslint-plugin-sonarjs";
import baseConfig from "./eslint.config.mjs";

const sonarConfig = [
  ...baseConfig,
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    ...sonarjs.configs.recommended,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    rules: {
      "react/no-array-index-key": "error", // S6479
      "react/no-unstable-nested-components": "error", // S6478
      "react/jsx-child-element-spacing": "error", // S6772
      "jsx-a11y/prefer-tag-over-role": "error", // S6819
      "@typescript-eslint/no-base-to-string": "error", // S6551
      "@typescript-eslint/require-await": "error", // S7503
      "@typescript-eslint/prefer-optional-chain": "error", // S6582
    },
  },
  {
    // Security hotspot rules that read test data as if it were production configuration. Each is still checked in
    // src and scripts.
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      // Literal addresses are the inputs the address blocking and client address tests check, not hosts to reach.
      "sonarjs/no-hardcoded-ip": "off",
      // http:// links are local test servers or samples the refusal tests feed in; nothing leaves the machine.
      "sonarjs/no-clear-text-protocols": "off",
      // Made-up passwords are the inputs the password tests check.
      "sonarjs/no-hardcoded-passwords": "off",
      // Random numbers only make test values unique; nothing depends on them being unpredictable.
      "sonarjs/pseudo-random": "off",
      // The service worker test runs the repository's own worker script in a sandbox to test it.
      "sonarjs/code-eval": "off",
      // Tests start npx, tsx and openssl from the test runner's own PATH, as the npm scripts do.
      "sonarjs/no-os-command-from-path": "off",
    },
  },
];

export default sonarConfig;
