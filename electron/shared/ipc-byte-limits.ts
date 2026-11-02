/** Limits applied before preload invokes IPC and independently when main receives a request. */
export const IPC_BYTES_MAX = 16 * 1024 * 1024;
/** Cached JSON in a TEXT column needs a larger ceiling than SQL text. */
export const DB_PARAM_STRING_MAX = 1024 * 1024;
export const DB_PARAMS_MAX = 1000;
