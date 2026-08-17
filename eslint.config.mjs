import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated and third-party browser runtimes are covered by integration
    // tests rather than linted as application source.
    "public/7z/**",
    "public/zip/**",
    "public/foliate-js/vendor/**",
    "src/vendor/fileCheckTitleNormalizer.js",
  ]),
]);

export default eslintConfig;
