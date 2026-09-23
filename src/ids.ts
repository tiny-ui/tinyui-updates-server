/** `app`, `channel` and package names: they are URL path segments and storage key parts, never anything else. */
export function isName(value: string): boolean {
    return /^[a-z0-9-]+$/.test(value) && !RESERVED.has(value);
}

/** A host version: a positive integer, so an App version such as `1.2.0` cannot be mistaken for one. */
export function isHostVersion(value: string): boolean {
    return /^[1-9][0-9]*$/.test(value);
}

/** `version`: one path segment, never `.` or `..`. */
export function isSegment(value: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

/** A file path inside a version directory: `runtime/core.bin`, `pages/home.bin`, `manifest.json`. */
export function isObjectPath(value: string): boolean {
    const segments = value.split("/");
    return segments.length > 0 && segments.every(isSegment);
}

/** An app id that would shadow a management route. */
const RESERVED = new Set(["apps"]);
