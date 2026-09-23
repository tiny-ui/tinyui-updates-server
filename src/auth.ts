import type { Context } from "hono";
import type { Storage } from "./storage.ts";

/** A publish token: issued per (app, package), limited to channels, stored only as a hash (tinyui docs/updates.md §6). */
export interface TokenRecord {
    id: string;
    app: string;
    pkg: string;
    channels: string[];
    createdAt: string;
}

export const docKeys = {
    app: (app: string) => `app:${app}`,
    pkg: (app: string, pkg: string) => `pkg:${app}:${pkg}`,
    tokenByHash: (hash: string) => `token:${hash}`,
    tokenById: (app: string, pkg: string, id: string) => `tokenid:${app}:${pkg}:${id}`,
    // one document per version and per channel: nothing is ever read, modified and written back
    release: (app: string, pkg: string, hostVersion: string, version: string) => `${docKeys.releasePrefix(app, pkg, hostVersion)}${version}`,
    releasePrefix: (app: string, pkg: string, hostVersion: string) => `release:${app}:${pkg}:${hostVersion}:`,
    pointer: (app: string, pkg: string, hostVersion: string, channel: string) => `${docKeys.pointerPrefix(app, pkg, hostVersion)}${channel}`,
    pointerPrefix: (app: string, pkg: string, hostVersion: string) => `pointer:${app}:${pkg}:${hostVersion}:`,
};

export function bearer(c: Context): string | null {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match?.[1] ?? null;
}

export function isAdmin(c: Context, adminToken: string): boolean {
    const token = bearer(c);
    return !!adminToken && token !== null && timingSafeEqual(token, adminToken);
}

/** The token record the request carries when it is a live token of (app, pkg); null otherwise. */
export async function packageToken(c: Context, storage: Storage, app: string, pkg: string): Promise<TokenRecord | null> {
    const token = bearer(c);
    if (!token) return null;
    const record = await storage.getDoc<TokenRecord>(docKeys.tokenByHash(await sha256Hex(token)));
    if (!record || record.app !== app || record.pkg !== pkg) return null;
    return record;
}

/** A fresh token: `<id>.<secret>`; the id is what revocation names, the whole string is what gets hashed. */
export async function issueToken(storage: Storage, app: string, pkg: string, channels: string[]): Promise<{ token: string; record: TokenRecord }> {
    const id = hex(crypto.getRandomValues(new Uint8Array(6)));
    const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const token = `${id}.${secret}`;
    const record: TokenRecord = { id, app, pkg, channels, createdAt: new Date().toISOString() };
    const hash = await sha256Hex(token);
    await storage.putDoc(docKeys.tokenByHash(hash), record);
    await storage.putDoc(docKeys.tokenById(app, pkg, id), { hash });
    return { token, record };
}

export async function revokeToken(storage: Storage, app: string, pkg: string, id: string): Promise<boolean> {
    const ref = await storage.getDoc<{ hash: string }>(docKeys.tokenById(app, pkg, id));
    if (!ref) return false;
    await storage.deleteDoc(docKeys.tokenByHash(ref.hash));
    await storage.deleteDoc(docKeys.tokenById(app, pkg, id));
    return true;
}

async function sha256Hex(text: string): Promise<string> {
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
