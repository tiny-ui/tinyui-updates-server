export interface AppRecord {
    id: string;
    name: string;
    /** Billing / ownership only; never part of a path (tinyui docs/updates.md §2.1). */
    org?: string;
    createdAt: string;
}

export interface PackageRecord {
    name: string;
    /** The key clients trust is the one embedded in the App; this copy lets publishing fail early (§6.1). */
    publicKey: string;
    createdAt: string;
    publicKeyUpdatedAt?: string;
}

/** One published version under (app, pkg, hostVersion): the pointer for any channel names one of these. */
export interface ReleaseRecord {
    createdAt: string;
    signature: string;
    publishedAt: string;
}

/** `current.json` as served (§1.2). */
export interface PointerDoc {
    version: string;
    rollout: number;
    signature: string;
}
