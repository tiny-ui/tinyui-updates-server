import type { Env } from "./env.ts";

/**
 * Metadata documents (small JSON) and immutable content objects; the only thing a deployment target has to provide.
 * Reads must see writes at once (a revoked token stops working now, a published pointer is served now), and
 * `putObjectIfAbsent` must be atomic: a version's bytes are written once and never replaced.
 */
export interface Storage {
    getDoc<T>(key: string): Promise<T | null>;
    putDoc(key: string, value: unknown): Promise<void>;
    /** A document with the revision [putDocIf] compares against. */
    getDocRevision<T>(key: string): Promise<{ value: T; revision: string } | null>;
    /** Writes only while the document is still at [revision] (null: still absent); false when it moved meanwhile. */
    putDocIf(key: string, value: unknown, revision: string | null): Promise<boolean>;
    deleteDoc(key: string): Promise<void>;
    /** Keys starting with [prefix]. */
    listDocs(prefix: string): Promise<string[]>;
    getObject(key: string): Promise<StoredObject | null>;
    streamObject(key: string): Promise<StreamedObject | null>;
    headObject(key: string): Promise<ObjectInfo | null>;
    /** False when something is already there, whatever it is. */
    putObjectIfAbsent(key: string, body: Uint8Array, sha256: string): Promise<boolean>;
}

export interface ObjectInfo {
    sha256: string;
    size: number;
}

export interface StoredObject extends ObjectInfo {
    body: Uint8Array;
}

export interface StreamedObject extends ObjectInfo {
    body: ReadableStream<Uint8Array>;
}

/** Cloudflare R2 for everything: strongly consistent, conditional writes, prefix listing; documents live under `docs/`. */
export class R2Storage implements Storage {
    constructor(private readonly bucket: R2Bucket) {}

    static fromEnv(env: Env): R2Storage {
        return new R2Storage(env.CONTENT);
    }

    async getDoc<T>(key: string): Promise<T | null> {
        const object = await this.bucket.get(`docs/${key}`);
        return object ? ((await object.json()) as T) : null;
    }

    async putDoc(key: string, value: unknown): Promise<void> {
        await this.bucket.put(`docs/${key}`, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });
    }

    async getDocRevision<T>(key: string): Promise<{ value: T; revision: string } | null> {
        const object = await this.bucket.get(`docs/${key}`);
        return object ? { value: (await object.json()) as T, revision: object.etag } : null;
    }

    async putDocIf(key: string, value: unknown, revision: string | null): Promise<boolean> {
        const onlyIf = revision === null ? { etagDoesNotMatch: "*" } : { etagMatches: revision };
        const written = await this.bucket.put(`docs/${key}`, JSON.stringify(value), { httpMetadata: { contentType: "application/json" }, onlyIf });
        return written !== null;
    }

    async deleteDoc(key: string): Promise<void> {
        await this.bucket.delete(`docs/${key}`);
    }

    async listDocs(prefix: string): Promise<string[]> {
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.bucket.list({ prefix: `docs/${prefix}`, ...(cursor && { cursor }) });
            for (const object of page.objects) keys.push(object.key.slice("docs/".length));
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return keys;
    }

    async getObject(key: string): Promise<StoredObject | null> {
        const object = await this.bucket.get(`objects/${key}`);
        if (!object) return null;
        const body = new Uint8Array(await object.arrayBuffer());
        return { body, size: body.byteLength, sha256: object.customMetadata?.["sha256"] ?? (await sha256Hex(body)) };
    }

    async streamObject(key: string): Promise<StreamedObject | null> {
        const object = await this.bucket.get(`objects/${key}`);
        if (!object) return null;
        const sha256 = object.customMetadata?.["sha256"];
        // objects this server wrote carry their hash; for anything else the bytes have to be read to know it
        if (!sha256) {
            const body = new Uint8Array(await object.arrayBuffer());
            return { body: streamOf(body), size: body.byteLength, sha256: await sha256Hex(body) };
        }
        return { body: object.body, size: object.size, sha256 };
    }

    async headObject(key: string): Promise<ObjectInfo | null> {
        const object = await this.bucket.head(`objects/${key}`);
        if (!object) return null;
        const sha256 = object.customMetadata?.["sha256"];
        if (sha256) return { sha256, size: object.size };
        const stored = await this.getObject(key);
        return stored && { sha256: stored.sha256, size: stored.size };
    }

    async putObjectIfAbsent(key: string, body: Uint8Array, sha256: string): Promise<boolean> {
        const written = await this.bucket.put(`objects/${key}`, body as BufferSource, { customMetadata: { sha256 }, onlyIf: { etagDoesNotMatch: "*" } });
        return written !== null;
    }
}

/** In-process storage for tests and for running the app outside Cloudflare. */
export class MemoryStorage implements Storage {
    private readonly docs = new Map<string, string>();
    private readonly revisions = new Map<string, number>();
    private readonly objects = new Map<string, StoredObject>();

    async getDoc<T>(key: string): Promise<T | null> {
        const value = this.docs.get(key);
        return value === undefined ? null : (JSON.parse(value) as T);
    }

    async putDoc(key: string, value: unknown): Promise<void> {
        this.docs.set(key, JSON.stringify(value));
        this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
    }

    async getDocRevision<T>(key: string): Promise<{ value: T; revision: string } | null> {
        const value = this.docs.get(key);
        return value === undefined ? null : { value: JSON.parse(value) as T, revision: String(this.revisions.get(key)) };
    }

    async putDocIf(key: string, value: unknown, revision: string | null): Promise<boolean> {
        const at = this.docs.has(key) ? String(this.revisions.get(key)) : null;
        if (at !== revision) return false;
        await this.putDoc(key, value);
        return true;
    }

    async deleteDoc(key: string): Promise<void> {
        this.docs.delete(key);
    }

    async listDocs(prefix: string): Promise<string[]> {
        return [...this.docs.keys()].filter((k) => k.startsWith(prefix)).sort();
    }

    async getObject(key: string): Promise<StoredObject | null> {
        return this.objects.get(key) ?? null;
    }

    async streamObject(key: string): Promise<StreamedObject | null> {
        const object = this.objects.get(key);
        return object ? { body: streamOf(object.body), size: object.size, sha256: object.sha256 } : null;
    }

    async headObject(key: string): Promise<ObjectInfo | null> {
        const object = this.objects.get(key);
        return object ? { sha256: object.sha256, size: object.size } : null;
    }

    async putObjectIfAbsent(key: string, body: Uint8Array, sha256: string): Promise<boolean> {
        if (this.objects.has(key)) return false;
        this.objects.set(key, { body, size: body.byteLength, sha256 });
        return true;
    }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
