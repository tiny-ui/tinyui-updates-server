import { isHostVersion, isName, isObjectPath, isSegment } from "./ids.ts";
import { looksLikePublicKey } from "./signature.ts";

/** The signed `<version>/manifest.json` `tinyui bundle` wrote (tinyui docs/updates.md §1.1), the fields this server checks. */
export interface Manifest {
    pages: string[];
    files: Record<string, string>;
    hashes: Record<string, string>;
    name: string;
    publicKey: string;
    version: string;
    createdAt: string;
    hostVersion: string;
    /** The package's strings: language → file path inside the version directory (tinyui docs/build-chain.md §8). */
    i18n?: { default: string; files: Record<string, string> };
}

/** Every file of the version besides `manifest.json`, with its key into `hashes`. */
export function payload(manifest: Manifest): { path: string; hashKey: string }[] {
    return [
        ...manifest.pages.map((module) => ({ path: `${manifest.files[module]}.bin`, hashKey: module })),
        ...Object.values(manifest.i18n?.files ?? {}).map((path) => ({ path, hashKey: path })),
    ];
}

/** Throws with a message naming the first field that is not what a bundle carries. */
export function parseManifest(text: string): Manifest {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error("manifest.json is not JSON");
    }
    if (typeof raw !== "object" || raw === null) throw new Error("manifest.json is not an object");
    const m = raw as Record<string, unknown>;
    const names = (key: "pages"): string[] => {
        const list = m[key];
        if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new Error(`manifest.json ${key} must list module names`);
        return list as string[];
    };
    const table = (key: "files" | "hashes"): Record<string, string> => {
        const map = m[key];
        if (typeof map !== "object" || map === null || !Object.values(map).every((v) => typeof v === "string")) throw new Error(`manifest.json ${key} must map module names to strings`);
        return map as Record<string, string>;
    };
    const string = (key: keyof Manifest): string => {
        const value = m[key];
        if (typeof value !== "string" || value === "") throw new Error(`manifest.json has no ${key}`);
        return value;
    };
    const manifest: Manifest = {
        pages: names("pages"),
        files: table("files"),
        hashes: table("hashes"),
        name: string("name"),
        publicKey: string("publicKey"),
        version: string("version"),
        createdAt: string("createdAt"),
        hostVersion: string("hostVersion"),
    };
    if (m["i18n"] !== undefined) {
        const i18n = m["i18n"] as Record<string, unknown> | null;
        const files = i18n?.["files"];
        if (typeof i18n !== "object" || i18n === null || typeof i18n["default"] !== "string" || typeof files !== "object" || files === null || !Object.values(files).every((v) => typeof v === "string")) {
            throw new Error("manifest.json i18n must be { default, files: { language: path } }");
        }
        // the runtime falls back to the default language, so it has to be one of the files
        if (!Object.hasOwn(files, i18n["default"])) throw new Error(`manifest.json i18n default ${JSON.stringify(i18n["default"])} has no file`);
        manifest.i18n = { default: i18n["default"], files: files as Record<string, string> };
    }
    if (!isName(manifest.name)) throw new Error("manifest.json name is not a package name");
    if (!isSegment(manifest.version)) throw new Error("manifest.json version is not a path segment");
    if (!isHostVersion(manifest.hostVersion)) throw new Error("manifest.json hostVersion is not a positive integer");
    if (instant(manifest.createdAt) === null) throw new Error("manifest.json createdAt is not a real YYYY-MM-DDTHH:MM:SSZ instant");
    if (!looksLikePublicKey(manifest.publicKey)) throw new Error("manifest.json publicKey is not a P-256 point");
    const modules = manifest.pages;
    if (new Set(modules).size !== modules.length) throw new Error("manifest.json lists a module twice");
    const strings = Object.values(manifest.i18n?.files ?? {});
    const expected = { files: modules, hashes: [...modules, ...strings] };
    for (const key of ["files", "hashes"] as const) {
        const keys = Object.keys(manifest[key]).sort();
        if (keys.join("\n") !== [...expected[key]].sort().join("\n")) throw new Error(`manifest.json ${key} does not cover exactly the modules in pages${key === "hashes" ? " and the i18n files" : ""}`);
    }
    for (const path of Object.values(manifest.files)) {
        if (!isObjectPath(path + ".bin")) throw new Error(`manifest.json files entry ${path} is not a file path`);
    }
    for (const path of strings) {
        if (!isObjectPath(path)) throw new Error(`manifest.json i18n file ${path} is not a file path`);
    }
    for (const hash of Object.values(manifest.hashes)) {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("manifest.json hashes must be sha256 hex");
    }
    return manifest;
}

/** Milliseconds of a `YYYY-MM-DDTHH:MM:SSZ` that names a real instant, as `tinyui build` writes it; null otherwise. */
export function instant(value: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
    const ms = Date.parse(value);
    // Date.parse rolls 2026-02-30 over into March: only a round trip proves the fields were in range
    return Number.isNaN(ms) || new Date(ms).toISOString() !== value.replace("Z", ".000Z") ? null : ms;
}
