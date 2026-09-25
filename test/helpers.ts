import { SELF } from "cloudflare:test";

export const ADMIN = "test-admin-token";

/** A package as `tinyui bundle` produces it, signed here with a fresh P-256 key. */
export interface SignedPackage {
    publicKey: string;
    privateKey: CryptoKey;
    manifest: Uint8Array;
    signature: string;
    version: string;
    files: Record<string, Uint8Array>;
}

export async function newKeyPair(): Promise<{ publicKey: string; privateKey: CryptoKey }> {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    return { publicKey: toBase64(raw), privateKey: pair.privateKey };
}

export async function signedPackage(options: {
    name?: string;
    hostVersion?: string;
    version?: string;
    createdAt?: string;
    key?: { publicKey: string; privateKey: CryptoKey };
    /** Overrides applied to the manifest before it is serialized and signed. */
    edit?: (m: Record<string, unknown>) => void;
    files?: Record<string, string>;
    /** language → the text of `i18n/<language>.json`; the first one is the default */
    i18n?: Record<string, string>;
} = {}): Promise<SignedPackage> {
    const name = options.name ?? "shop";
    const version = options.version ?? "20260922T100000Z-abcdef1";
    const key = options.key ?? (await newKeyPair());
    const strings = Object.fromEntries(Object.entries(options.i18n ?? {}).map(([language, text]) => [`i18n/${language}.json`, text]));
    const contents = { ...(options.files ?? { "pages/home.bin": `HOME-${version}` }), ...strings };
    const files = Object.fromEntries(Object.entries(contents).map(([p, text]) => [p, new TextEncoder().encode(text)]));
    const modules: Record<string, string> = { [`${name}/home`]: "pages/home" };
    const hashes: Record<string, string> = {};
    for (const [module, path] of Object.entries(modules)) hashes[module] = await sha256Hex(files[`${path}.bin`]!);
    for (const path of Object.keys(strings)) hashes[path] = await sha256Hex(files[path]!);
    const manifest: Record<string, unknown> = {
        pages: [`${name}/home`],
        files: modules,
        buildIds: Object.fromEntries(Object.keys(modules).map((m) => [m, "00000000"])),
        name,
        publicKey: key.publicKey,
        version,
        createdAt: options.createdAt ?? "2026-09-22T10:00:00Z",
        engine: "e".repeat(40),
        tinyui: "0.7.0",
        hashes,
        hostVersion: options.hostVersion ?? "1",
        ...(options.i18n && {
            i18n: { default: Object.keys(options.i18n)[0], files: Object.fromEntries(Object.keys(options.i18n).map((language) => [language, `i18n/${language}.json`])) },
        }),
    };
    options.edit?.(manifest);
    const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");
    return { publicKey: key.publicKey, privateKey: key.privateKey, manifest: bytes, signature: await sign(key.privateKey, bytes), version, files };
}

/** DER-encoded ECDSA over [data], as `tinyui bundle` writes into current.json. */
export async function sign(privateKey: CryptoKey, data: Uint8Array): Promise<string> {
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data as BufferSource));
    return toBase64(p1363ToDer(p1363));
}

function p1363ToDer(sig: Uint8Array): Uint8Array {
    const integer = (bytes: Uint8Array) => {
        let v = bytes;
        while (v.length > 1 && v[0] === 0) v = v.subarray(1);
        const padded = v[0]! & 0x80 ? new Uint8Array([0, ...v]) : v;
        return new Uint8Array([0x02, padded.length, ...padded]);
    };
    const r = integer(sig.subarray(0, 32));
    const s = integer(sig.subarray(32, 64));
    return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

export function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    let body = init.body;
    if (init.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(init.json);
    }
    return SELF.fetch(`https://updates.test${path}`, { ...init, headers, body: body ?? null });
}

/** An app with one package and one token, ready to publish. */
export async function setup(options: { app?: string; pkg?: string; channels?: string[]; publicKey: string }): Promise<{ app: string; pkg: string; token: string; tokenId: string }> {
    // storage is shared within a test file: every setup gets its own app unless the test says otherwise
    const app = options.app ?? "demo-" + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
    const pkg = options.pkg ?? "shop";
    const created = await request("/apps", { method: "POST", token: ADMIN, json: { id: app, name: "Demo" } });
    if (created.status !== 201 && created.status !== 409) throw new Error(`app: ${created.status} ${await created.text()}`);
    const p = await request(`/apps/${app}/packages`, { method: "POST", token: ADMIN, json: { name: pkg, publicKey: options.publicKey } });
    if (p.status !== 201) throw new Error(`package: ${p.status} ${await p.text()}`);
    const t = await request(`/apps/${app}/packages/${pkg}/tokens`, { method: "POST", token: ADMIN, json: { channels: options.channels ?? ["staging", "production"] } });
    const tokenBody = (await t.json()) as { id: string; token: string };
    return { app, pkg, token: tokenBody.token, tokenId: tokenBody.id };
}

/** Uploads every file and the manifest, i.e. what `tinyui publish` does before writing the pointer. */
export async function uploadContent(app: string, pkg: string, hostVersion: string, p: SignedPackage, token: string): Promise<void> {
    for (const [path, bytes] of Object.entries(p.files)) {
        const r = await request(`/${app}/${pkg}/${hostVersion}/${p.version}/${path}`, { method: "PUT", token, body: bytes as BodyInit });
        if (r.status !== 201 && r.status !== 200) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    }
    const m = await request(`/${app}/${pkg}/${hostVersion}/${p.version}/manifest.json`, { method: "PUT", token, body: p.manifest as BodyInit });
    if (m.status !== 201 && m.status !== 200) throw new Error(`manifest: ${m.status} ${await m.text()}`);
}

export function publishPointer(app: string, channel: string, pkg: string, hostVersion: string, p: SignedPackage, token: string, rollout?: number): Promise<Response> {
    return request(`/${app}/${channel}/${pkg}/${hostVersion}/current.json`, { method: "PUT", token, json: { version: p.version, signature: p.signature, ...(rollout !== undefined && { rollout }) } });
}
