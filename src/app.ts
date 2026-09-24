import { Hono } from "hono";
import type { Context } from "hono";
import { anyPackageToken, canManage, docKeys, isAdmin, issueAppToken, issueToken, packageToken, revokeAppToken, revokeToken } from "./auth.ts";
import { isHostVersion, isName, isObjectPath, isSegment } from "./ids.ts";
import { instant, parseManifest } from "./manifest.ts";
import type { AppRecord, PackageRecord, PointerDoc, ReleaseRecord } from "./records.ts";
import { isPublicKey, verifySignature } from "./signature.ts";
import { sha256Hex, type Storage } from "./storage.ts";

export interface Deps {
    storage: Storage;
    adminToken: string;
    maxObjectBytes: number;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export function createApp({ storage, adminToken, maxObjectBytes }: Deps): Hono {
    const app = new Hono();
    const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 413, error: string) => c.json({ error }, status);
    const objectKey = (app: string, pkg: string, hostVersion: string, version: string, path: string) => `${app}/${pkg}/${hostVersion}/${version}/${path}`;
    // `_` is not allowed in an app id, so these keys never meet a package's content
    const hostKey = (app: string, hostVersion: string) => `_hosts/${app}/${hostVersion}`;

    app.get("/", (c) => c.text("tinyui-updates"));

    // ---- management (ADMIN_TOKEN), tinyui docs/updates.md §6.3 ----

    const admin = async (c: Context, next: () => Promise<void>) => (isAdmin(c, adminToken) ? next() : fail(c, 401, "admin token required"));
    // everything else under /apps/<app>: the admin token or that app's app token; ids are checked by each route
    const manager = async (c: Context, next: () => Promise<void>) =>
        (await canManage(c, storage, adminToken, c.req.param("app") ?? "")) ? next() : fail(c, 401, "the admin token or an app token of this app is required");
    app.post("/apps", admin);
    app.post("/apps/:app/tokens", admin);
    app.delete("/apps/:app/tokens/:tokenId", admin);
    app.post("/apps/:app/packages", manager);
    app.on(["POST", "PUT", "DELETE"], "/apps/:app/packages/*", manager);
    app.put("/apps/:app/hosts/:hostVersion", manager);

    app.post("/apps", async (c) => {
        const body = await json(c);
        const id = body?.["id"];
        const name = body?.["name"];
        const org = body?.["org"];
        if (typeof id !== "string" || !isName(id)) return fail(c, 400, "id must match [a-z0-9-]+ and not be reserved");
        if (typeof name !== "string" || name === "") return fail(c, 400, "name is required");
        if (org !== undefined && typeof org !== "string") return fail(c, 400, "org must be a string");
        if (await storage.getDoc(docKeys.app(id))) return fail(c, 409, `app ${id} exists`);
        const record: AppRecord = { id, name, createdAt: new Date().toISOString(), ...(org !== undefined && { org }) };
        await storage.putDoc(docKeys.app(id), record);
        return c.json(record, 201);
    });

    app.post("/apps/:app/tokens", async (c) => {
        const appId = c.req.param("app");
        if (!isName(appId) || !(await storage.getDoc(docKeys.app(appId)))) return fail(c, 404, `no app ${appId}`);
        const { token, record } = await issueAppToken(storage, appId);
        return c.json({ id: record.id, token, createdAt: record.createdAt }, 201);
    });

    app.delete("/apps/:app/tokens/:tokenId", async (c) => {
        const { app: appId, tokenId } = c.req.param();
        if (!isName(appId) || !(await revokeAppToken(storage, appId, tokenId))) return fail(c, 404, "no such token");
        return c.body(null, 204);
    });

    // host snapshots, §6.4: written once per (app, hostVersion) by the host's CI, read back by `tinyui bundle`
    app.put("/apps/:app/hosts/:hostVersion", async (c) => {
        const { app: appId, hostVersion } = c.req.param();
        if (!isName(appId) || !isHostVersion(hostVersion) || !(await storage.getDoc(docKeys.app(appId)))) return fail(c, 404, "not found");
        const body = await readBounded(c.req.raw.body, maxObjectBytes);
        if (!body) return fail(c, 413, `snapshots are limited to ${maxObjectBytes} bytes`);
        if (body.byteLength === 0) return fail(c, 400, "a snapshot cannot be empty");
        const sha256 = await sha256Hex(body);
        const key = hostKey(appId, hostVersion);
        if (await storage.putObjectIfAbsent(key, body, sha256)) return c.json({ hostVersion, sha256, existing: false }, 201);
        const existing = await storage.headObject(key);
        if (existing?.sha256 === sha256) return c.json({ hostVersion, sha256, existing: true });
        return fail(c, 409, `host version ${hostVersion} of ${appId} already has a different snapshot; a shipped host version is frozen`);
    });

    app.get("/apps/:app/hosts/:hostVersion", async (c) => {
        const { app: appId, hostVersion } = c.req.param();
        if (!isName(appId) || !isHostVersion(hostVersion)) return fail(c, 404, "not found");
        if (!(await canManage(c, storage, adminToken, appId)) && !(await anyPackageToken(c, storage, appId))) return fail(c, 401, "a token of this app is required");
        const object = await storage.getObject(hostKey(appId, hostVersion));
        if (!object) return fail(c, 404, `host version ${hostVersion} of ${appId} has no snapshot; upload it from the host's CI`);
        return c.body(object.body as unknown as ArrayBuffer, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    });

    app.post("/apps/:app/packages", async (c) => {
        const appId = c.req.param("app");
        if (!isName(appId) || !(await storage.getDoc(docKeys.app(appId)))) return fail(c, 404, `no app ${appId}`);
        const body = await json(c);
        const name = body?.["name"];
        const publicKey = body?.["publicKey"];
        if (typeof name !== "string" || !isName(name)) return fail(c, 400, "name must match [a-z0-9-]+");
        if (typeof publicKey !== "string" || !(await isPublicKey(publicKey))) return fail(c, 400, "publicKey must be a P-256 uncompressed point in base64");
        if (await storage.getDoc(docKeys.pkg(appId, name))) return fail(c, 409, `package ${name} exists in ${appId}`);
        const record: PackageRecord = { name, publicKey, createdAt: new Date().toISOString() };
        await storage.putDoc(docKeys.pkg(appId, name), record);
        return c.json(record, 201);
    });

    app.put("/apps/:app/packages/:pkg/publicKey", async (c) => {
        const { app: appId, pkg } = c.req.param();
        const record = isName(appId) && isName(pkg) ? await storage.getDoc<PackageRecord>(docKeys.pkg(appId, pkg)) : null;
        if (!record) return fail(c, 404, `no package ${pkg} in ${appId}`);
        const publicKey = (await json(c))?.["publicKey"];
        if (typeof publicKey !== "string" || !(await isPublicKey(publicKey))) return fail(c, 400, "publicKey must be a P-256 uncompressed point in base64");
        const updated: PackageRecord = { ...record, publicKey, publicKeyUpdatedAt: new Date().toISOString() };
        await storage.putDoc(docKeys.pkg(appId, pkg), updated);
        return c.json(updated);
    });

    app.post("/apps/:app/packages/:pkg/tokens", async (c) => {
        const { app: appId, pkg } = c.req.param();
        if (!isName(appId) || !isName(pkg) || !(await storage.getDoc(docKeys.pkg(appId, pkg)))) return fail(c, 404, `no package ${pkg} in ${appId}`);
        const channels = (await json(c))?.["channels"];
        if (!Array.isArray(channels) || channels.length === 0 || !channels.every((ch) => typeof ch === "string" && isName(ch))) {
            return fail(c, 400, "channels must be a non-empty list of channel names");
        }
        const { token, record } = await issueToken(storage, appId, pkg, channels as string[]);
        // the token itself is returned exactly once; only its hash is kept
        return c.json({ id: record.id, token, channels: record.channels, createdAt: record.createdAt }, 201);
    });

    app.delete("/apps/:app/packages/:pkg/tokens/:tokenId", async (c) => {
        const { app: appId, pkg, tokenId } = c.req.param();
        if (!isName(appId) || !isName(pkg) || !(await revokeToken(storage, appId, pkg, tokenId))) return fail(c, 404, "no such token");
        return c.body(null, 204);
    });

    // ---- releases (package token or admin), §6.2 ----

    app.get("/:app/:pkg/:hostVersion/releases", async (c) => {
        const { app: appId, pkg, hostVersion } = c.req.param();
        if (!isName(appId) || !isName(pkg) || !isHostVersion(hostVersion)) return fail(c, 404, "not found");
        if (!(await canManage(c, storage, adminToken, appId)) && !(await packageToken(c, storage, appId, pkg))) return fail(c, 401, "a token for this package is required");
        const releasePrefix = docKeys.releasePrefix(appId, pkg, hostVersion);
        const versions: { version: string; createdAt: string; publishedAt: string }[] = [];
        for (const key of await storage.listDocs(releasePrefix)) {
            const release = await storage.getDoc<ReleaseRecord>(key);
            if (release) versions.push({ version: key.slice(releasePrefix.length), createdAt: release.createdAt, publishedAt: release.publishedAt });
        }
        versions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        const pointerPrefix = docKeys.pointerPrefix(appId, pkg, hostVersion);
        const channels: Record<string, { version: string; rollout: number }> = {};
        for (const key of await storage.listDocs(pointerPrefix)) {
            const pointer = await storage.getDoc<PointerDoc>(key);
            if (pointer) channels[key.slice(pointerPrefix.length)] = { version: pointer.version, rollout: pointer.rollout };
        }
        return c.json({ versions, channels });
    });

    app.post("/:app/:channel/:pkg/:hostVersion/pointer", async (c) => {
        const { app: appId, channel, pkg, hostVersion } = c.req.param();
        if (!isName(appId) || !isName(channel) || !isName(pkg) || !isHostVersion(hostVersion)) return fail(c, 404, "not found");
        const token = await packageToken(c, storage, appId, pkg);
        if (!token) return fail(c, 401, "a token for this package is required");
        if (!token.channels.includes(channel)) return fail(c, 403, `token is not allowed to publish to ${channel}`);
        const body = await json(c);
        const pointerKey = docKeys.pointer(appId, pkg, hostVersion, channel);
        const at = await storage.getDocRevision<PointerDoc>(pointerKey);
        const current = at?.value ?? null;
        const version = body?.["version"] ?? current?.version;
        if (typeof version !== "string" || !isSegment(version)) return fail(c, 400, "version is required");
        const release = await storage.getDoc<ReleaseRecord>(docKeys.release(appId, pkg, hostVersion, version));
        if (!release) return fail(c, 404, `version ${version} was never published under ${appId}/${pkg}/${hostVersion}`);
        const rollout = parseRollout(body?.["rollout"], current && current.version === version ? current.rollout : 100);
        if (rollout === null) return fail(c, 400, "rollout must be an integer from 0 to 100");
        const backwards = await movesBack(storage, appId, pkg, hostVersion, current, version, release.createdAt);
        if (backwards) return fail(c, 409, backwards);
        const pointer: PointerDoc = { version, rollout, signature: release.signature };
        if (!(await storage.putDocIf(pointerKey, pointer, at?.revision ?? null))) return fail(c, 409, MOVED_MEANWHILE);
        return c.json(pointer);
    });

    // ---- publishing (package token), §6.1 ----

    app.put("/:app/:channel/:pkg/:hostVersion/current.json", async (c) => {
        const { app: appId, channel, pkg, hostVersion } = c.req.param();
        if (!isName(appId) || !isName(channel) || !isName(pkg) || !isHostVersion(hostVersion)) return fail(c, 404, "not found");
        const token = await packageToken(c, storage, appId, pkg);
        if (!token) return fail(c, 401, "a token for this package is required");
        if (!token.channels.includes(channel)) return fail(c, 403, `token is not allowed to publish to ${channel}`);
        const registered = await storage.getDoc<PackageRecord>(docKeys.pkg(appId, pkg));
        if (!registered) return fail(c, 404, `no package ${pkg} in ${appId}`);
        const body = await json(c);
        const version = body?.["version"];
        const signature = body?.["signature"];
        if (typeof version !== "string" || !isSegment(version)) return fail(c, 400, "version must be a path segment");
        if (typeof signature !== "string" || signature === "") return fail(c, 400, "signature is required");
        const rollout = parseRollout(body?.["rollout"], 100);
        if (rollout === null) return fail(c, 400, "rollout must be an integer from 0 to 100");

        const stored = await storage.getObject(objectKey(appId, pkg, hostVersion, version, "manifest.json"));
        if (!stored) return fail(c, 409, `${version}/manifest.json is not uploaded yet: content first, pointer last`);
        // the registered key, never the one inside the manifest: a token cannot bring its own key
        if (!(await verifySignature(registered.publicKey, stored.body, signature))) return fail(c, 400, "signature does not verify with the registered publicKey");
        let manifest;
        try {
            manifest = parseManifest(new TextDecoder().decode(stored.body));
        } catch (e) {
            return fail(c, 400, (e as Error).message);
        }
        if (manifest.name !== pkg) return fail(c, 400, `manifest name ${manifest.name} is not the path package ${pkg}`);
        if (manifest.hostVersion !== hostVersion) return fail(c, 400, `manifest hostVersion ${manifest.hostVersion} is not the path host version ${hostVersion}`);
        if (manifest.version !== version) return fail(c, 400, `manifest version ${manifest.version} is not the pointer version ${version}`);
        if (manifest.publicKey !== registered.publicKey) return fail(c, 400, "manifest publicKey is not the registered one");
        for (const module of [...manifest.runtime, ...manifest.pages]) {
            const path = manifest.files[module] + ".bin";
            const info = await storage.headObject(objectKey(appId, pkg, hostVersion, version, path));
            if (!info) return fail(c, 409, `${version}/${path} is not uploaded yet`);
            if (info.sha256 !== manifest.hashes[module]) return fail(c, 409, `${version}/${path} does not match manifest.hashes`);
        }

        const pointerKey = docKeys.pointer(appId, pkg, hostVersion, channel);
        const at = await storage.getDocRevision<PointerDoc>(pointerKey);
        const current = at?.value ?? null;
        const backwards = await movesBack(storage, appId, pkg, hostVersion, current, version, manifest.createdAt);
        if (backwards) return fail(c, 409, backwards);
        const releaseKey = docKeys.release(appId, pkg, hostVersion, version);
        const existing = await storage.getDoc<ReleaseRecord>(releaseKey);
        const release: ReleaseRecord = { createdAt: manifest.createdAt, signature, publishedAt: existing?.publishedAt ?? new Date().toISOString() };
        await storage.putDoc(releaseKey, release);
        const pointer: PointerDoc = { version, rollout, signature };
        if (!(await storage.putDocIf(pointerKey, pointer, at?.revision ?? null))) return fail(c, 409, `${version} is recorded and can be promoted, but ${MOVED_MEANWHILE}`);
        return c.json(pointer);
    });

    app.put("/:app/:pkg/:hostVersion/:version/*", async (c) => {
        const { app: appId, pkg, hostVersion, version } = c.req.param();
        const path = c.req.path.split("/").slice(5).join("/");
        if (!isName(appId) || !isName(pkg) || !isHostVersion(hostVersion) || !isSegment(version) || !isObjectPath(path)) return fail(c, 404, "not found");
        if (!(await packageToken(c, storage, appId, pkg))) return fail(c, 401, "a token for this package is required");
        const length = Number(c.req.header("content-length") ?? "0");
        if (length > maxObjectBytes) return fail(c, 413, `objects are limited to ${maxObjectBytes} bytes`);
        const body = await readBounded(c.req.raw.body, maxObjectBytes);
        if (!body) return fail(c, 413, `objects are limited to ${maxObjectBytes} bytes`);
        const sha256 = await sha256Hex(body);
        const key = objectKey(appId, pkg, hostVersion, version, path);
        if (await storage.putObjectIfAbsent(key, body, sha256)) return c.json({ path, sha256, existing: false }, 201);
        // a version never changes: the same bytes again are fine, different ones are another version's business
        const existing = await storage.headObject(key);
        if (existing?.sha256 === sha256) return c.json({ path, sha256, existing: true });
        return fail(c, 409, `${version}/${path} already exists with different content`);
    });

    // ---- delivery (public), §2 ----

    app.get("/:app/:channel/:pkg/:hostVersion/current.json", async (c) => {
        const { app: appId, channel, pkg, hostVersion } = c.req.param();
        if (!isName(appId) || !isName(channel) || !isName(pkg) || !isHostVersion(hostVersion)) return fail(c, 404, "not found");
        const pointer = await storage.getDoc<PointerDoc>(docKeys.pointer(appId, pkg, hostVersion, channel));
        if (!pointer) return fail(c, 404, "not found");
        return c.json(pointer, 200, { "Cache-Control": "no-store" });
    });

    app.get("/:app/:channel/:pkg/:hostVersion/:version/*", async (c) => {
        const { app: appId, channel, pkg, hostVersion, version } = c.req.param();
        const path = c.req.path.split("/").slice(6).join("/");
        if (!isName(appId) || !isName(channel) || !isName(pkg) || !isHostVersion(hostVersion) || !isSegment(version) || !isObjectPath(path)) return fail(c, 404, "not found");
        // the channel is not part of the key: one upload serves every channel that points at it
        const object = await storage.streamObject(objectKey(appId, pkg, hostVersion, version, path));
        if (!object) return fail(c, 404, "not found");
        return c.body(object.body, 200, {
            "Cache-Control": IMMUTABLE,
            "Content-Type": path.endsWith(".json") ? "application/json" : "application/octet-stream",
            "Content-Length": String(object.size),
        });
    });

    return app;
}

/** The whole body, or null as soon as it exceeds [max] bytes: nothing larger is buffered or hashed. */
async function readBounded(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
    if (!stream) return new Uint8Array(0);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

async function json(c: Context): Promise<Record<string, unknown> | null> {
    try {
        const value: unknown = await c.req.json();
        return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function parseRollout(value: unknown, fallback: number): number | null {
    if (value === undefined) return fallback;
    return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100 ? (value as number) : null;
}

/**
 * Why pointing [version] would move the channel back, or null. Pointers only move forward: a rollback
 * is a new version with the old content (docs/updates.md §6.2), so every device can reach it.
 */
async function movesBack(storage: Storage, app: string, pkg: string, hostVersion: string, current: PointerDoc | null, version: string, createdAt: string): Promise<string | null> {
    if (!current || current.version === version) return null;
    const at = await storage.getDoc<ReleaseRecord>(docKeys.release(app, pkg, hostVersion, current.version));
    if (!at) return `the channel points at ${current.version}, which has no release record; refusing to move it`;
    const from = instant(at.createdAt);
    const to = instant(createdAt);
    if (from !== null && to !== null && to > from) return null;
    return `the channel is at ${current.version} (${at.createdAt}); ${version} (${createdAt}) is not newer. Pointers only move forward: publish the old content as a new version`;
}

/** The pointer changed between the forward-only check and the write: another publish or promotion won. */
const MOVED_MEANWHILE = "the channel pointer changed meanwhile; look at it again and retry";
