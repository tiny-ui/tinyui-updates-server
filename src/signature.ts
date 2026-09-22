// ECDSA P-256 / SHA-256 over raw bytes: X9.63 public key and DER signature, both base64 (tinyui docs/updates.md §7).

/** The shape of a key: 65 bytes, `04`-prefixed. Whether it is a point on the curve is [isPublicKey]'s question. */
export function looksLikePublicKey(value: string): boolean {
    const bytes = fromBase64(value);
    return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
}

/** A key WebCrypto accepts as a P-256 public key, i.e. one that can verify anything at all. */
export async function isPublicKey(value: string): Promise<boolean> {
    const bytes = fromBase64(value);
    if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return false;
    try {
        await crypto.subtle.importKey("raw", bytes as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        return true;
    } catch {
        return false;
    }
}

/** True when [signature] was made over exactly [data] by the private key of [publicKey]. */
export async function verifySignature(publicKey: string, data: Uint8Array, signature: string): Promise<boolean> {
    const raw = fromBase64(publicKey);
    const der = fromBase64(signature);
    if (!raw || raw.length !== 65 || raw[0] !== 0x04 || !der) return false;
    const p1363 = derToP1363(der);
    if (!p1363) return false;
    try {
        const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, p1363 as BufferSource, data as BufferSource);
    } catch {
        return false;
    }
}

/** `SEQUENCE { INTEGER r, INTEGER s }` → `r ‖ s`, 32 bytes each, as WebCrypto wants it. */
function derToP1363(der: Uint8Array): Uint8Array | null {
    let i = 0;
    if (der[i++] !== 0x30) return null;
    const total = readLength(der, i);
    if (!total) return null;
    i = total.next;
    const out = new Uint8Array(64);
    for (const offset of [0, 32]) {
        if (der[i++] !== 0x02) return null;
        const len = readLength(der, i);
        if (!len) return null;
        i = len.next;
        let value = der.subarray(i, i + len.value);
        i += len.value;
        while (value.length > 32 && value[0] === 0) value = value.subarray(1);
        if (value.length > 32) return null;
        out.set(value, offset + 32 - value.length);
    }
    return i === der.length ? out : null;
}

function readLength(bytes: Uint8Array, at: number): { value: number; next: number } | null {
    const first = bytes[at];
    if (first === undefined) return null;
    if (first < 0x80) return { value: first, next: at + 1 };
    const count = first & 0x7f;
    if (count === 0 || count > 2) return null;
    let value = 0;
    for (let k = 0; k < count; k++) {
        const b = bytes[at + 1 + k];
        if (b === undefined) return null;
        value = (value << 8) | b;
    }
    return { value, next: at + 1 + count };
}

export function fromBase64(value: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
    try {
        const binary = atob(value);
        return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    } catch {
        return null;
    }
}
