export interface Env {
    /** Documents under `docs/`, package content under `objects/` (src/storage.ts). */
    CONTENT: R2Bucket;
    /** Secret: the management endpoints' bearer token (docs/updates.md §6.3 of the tinyui repo). */
    ADMIN_TOKEN: string;
    MAX_OBJECT_BYTES: string;
}
