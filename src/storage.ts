import type { Env } from "./env.ts";

/** Metadata documents (small JSON) and immutable content objects; the only thing a deployment target has to provide. */
export interface Storage {
    getDoc<T>(key: string): Promise<T | null>;
    putDoc(key: string, value: unknown): Promise<void>;
    deleteDoc(key: string): Promise<void>;
    getObject(key: string): Promise<StoredObject | null>;
    headObject(key: string): Promise<ObjectInfo | null>;
    putObject(key: string, body: Uint8Array, sha256: string): Promise<void>;
}

export interface ObjectInfo {
    sha256: string;
    size: number;
}

export interface StoredObject extends ObjectInfo {
    body: Uint8Array;
}

/** Cloudflare: documents in KV, objects in R2 with the sha256 kept as custom metadata. */
export class KvR2Storage implements Storage {
    constructor(private readonly kv: KVNamespace, private readonly bucket: R2Bucket) {}

    static fromEnv(env: Env): KvR2Storage {
        return new KvR2Storage(env.STATE, env.CONTENT);
    }

    getDoc<T>(key: string): Promise<T | null> {
        return this.kv.get<T>(key, "json");
    }

    async putDoc(key: string, value: unknown): Promise<void> {
        await this.kv.put(key, JSON.stringify(value));
    }

    deleteDoc(key: string): Promise<void> {
        return this.kv.delete(key);
    }

    async getObject(key: string): Promise<StoredObject | null> {
        const object = await this.bucket.get(key);
        if (!object) return null;
        const body = new Uint8Array(await object.arrayBuffer());
        return { body, size: body.byteLength, sha256: object.customMetadata?.["sha256"] ?? (await sha256Hex(body)) };
    }

    async headObject(key: string): Promise<ObjectInfo | null> {
        const object = await this.bucket.head(key);
        if (!object) return null;
        const sha256 = object.customMetadata?.["sha256"];
        // objects written by this server always carry it; anything else is hashed on demand
        if (sha256) return { sha256, size: object.size };
        const stored = await this.getObject(key);
        return stored && { sha256: stored.sha256, size: stored.size };
    }

    async putObject(key: string, body: Uint8Array, sha256: string): Promise<void> {
        await this.bucket.put(key, body, { customMetadata: { sha256 } });
    }
}

/** In-process storage for tests and for running the app outside Cloudflare. */
export class MemoryStorage implements Storage {
    private readonly docs = new Map<string, string>();
    private readonly objects = new Map<string, StoredObject>();

    async getDoc<T>(key: string): Promise<T | null> {
        const value = this.docs.get(key);
        return value === undefined ? null : (JSON.parse(value) as T);
    }

    async putDoc(key: string, value: unknown): Promise<void> {
        this.docs.set(key, JSON.stringify(value));
    }

    async deleteDoc(key: string): Promise<void> {
        this.docs.delete(key);
    }

    async getObject(key: string): Promise<StoredObject | null> {
        return this.objects.get(key) ?? null;
    }

    async headObject(key: string): Promise<ObjectInfo | null> {
        const object = this.objects.get(key);
        return object ? { sha256: object.sha256, size: object.size } : null;
    }

    async putObject(key: string, body: Uint8Array, sha256: string): Promise<void> {
        this.objects.set(key, { body, size: body.byteLength, sha256 });
    }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
