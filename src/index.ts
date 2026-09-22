import type { Hono } from "hono";
import { createApp } from "./app.ts";
import type { Env } from "./env.ts";
import { KvR2Storage } from "./storage.ts";

let cached: { env: Env; app: Hono } | undefined;

export default {
    fetch(request, env, ctx) {
        if (cached?.env !== env) {
            cached = { env, app: createApp({ storage: KvR2Storage.fromEnv(env), adminToken: env.ADMIN_TOKEN ?? "", maxObjectBytes: Number(env.MAX_OBJECT_BYTES) || 16 * 1024 * 1024 }) };
        }
        return cached.app.fetch(request, env, ctx);
    },
} satisfies ExportedHandler<Env>;
