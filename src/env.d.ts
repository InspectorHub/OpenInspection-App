/// <reference types="vite/client" />

/** The `version` of package.json, injected at build time by vite.config.ts. */
declare const __APP_VERSION__: string;

/** The UTC ISO instant the build ran (or `APP_BUILT_AT`), injected by vite.config.ts. */
declare const __APP_BUILT_AT__: string;
