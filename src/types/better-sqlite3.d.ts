// Ambient declaration so tsc accepts the runtime dependency `better-sqlite3` (no @types installed).
// The Career-Hunter routes use it to read the per-user engine SQLite (with the shared corpus ATTACHed).
declare module 'better-sqlite3';
