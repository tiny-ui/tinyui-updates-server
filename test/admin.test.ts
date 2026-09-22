import { describe, expect, it } from "vitest";
import { ADMIN, newKeyPair, request } from "./helpers.ts";

describe("management endpoints", () => {
    it("need the admin token", async () => {
        expect((await request("/apps", { method: "POST", json: { id: "a", name: "A" } })).status).toBe(401);
        expect((await request("/apps", { method: "POST", token: "wrong", json: { id: "a", name: "A" } })).status).toBe(401);
        expect((await request("/apps/a/packages", { method: "POST", json: { name: "p", publicKey: "x" } })).status).toBe(401);
    });

    it("create apps and packages once, with valid ids and keys", async () => {
        const key = await newKeyPair();
        expect((await request("/apps", { method: "POST", token: ADMIN, json: { id: "Demo", name: "Demo" } })).status).toBe(400);
        expect((await request("/apps", { method: "POST", token: ADMIN, json: { id: "apps", name: "shadows a route" } })).status).toBe(400);
        const created = await request("/apps", { method: "POST", token: ADMIN, json: { id: "demo", name: "Demo", org: "acme" } });
        expect(created.status).toBe(201);
        expect(await created.json()).toMatchObject({ id: "demo", name: "Demo", org: "acme" });
        expect((await request("/apps", { method: "POST", token: ADMIN, json: { id: "demo", name: "Again" } })).status).toBe(409);

        expect((await request("/apps/nowhere/packages", { method: "POST", token: ADMIN, json: { name: "shop", publicKey: key.publicKey } })).status).toBe(404);
        expect((await request("/apps/demo/packages", { method: "POST", token: ADMIN, json: { name: "shop", publicKey: "bm90IGEga2V5" } })).status).toBe(400);
        const pkg = await request("/apps/demo/packages", { method: "POST", token: ADMIN, json: { name: "shop", publicKey: key.publicKey } });
        expect(pkg.status).toBe(201);
        expect((await request("/apps/demo/packages", { method: "POST", token: ADMIN, json: { name: "shop", publicKey: key.publicKey } })).status).toBe(409);

        const rotated = await newKeyPair();
        const put = await request("/apps/demo/packages/shop/publicKey", { method: "PUT", token: ADMIN, json: { publicKey: rotated.publicKey } });
        expect(put.status).toBe(200);
        expect(((await put.json()) as { publicKey: string }).publicKey).toBe(rotated.publicKey);
    });

    it("issue tokens once and revoke them by id", async () => {
        const key = await newKeyPair();
        await request("/apps", { method: "POST", token: ADMIN, json: { id: "demo", name: "Demo" } });
        await request("/apps/demo/packages", { method: "POST", token: ADMIN, json: { name: "shop", publicKey: key.publicKey } });
        expect((await request("/apps/demo/packages/shop/tokens", { method: "POST", token: ADMIN, json: { channels: [] } })).status).toBe(400);
        expect((await request("/apps/demo/packages/shop/tokens", { method: "POST", token: ADMIN, json: { channels: ["Prod"] } })).status).toBe(400);
        const issued = await request("/apps/demo/packages/shop/tokens", { method: "POST", token: ADMIN, json: { channels: ["staging"] } });
        expect(issued.status).toBe(201);
        const { id, token } = (await issued.json()) as { id: string; token: string };
        expect(token).toMatch(new RegExp(`^${id}\\.[A-Za-z0-9_-]{43}$`));

        expect((await request("/demo/shop/1/releases", { token })).status).toBe(200);
        expect((await request("/demo/shop/1/releases", { token: "nope" })).status).toBe(401);
        expect((await request("/demo/shop/1/releases", { token: ADMIN })).status).toBe(200);

        expect((await request(`/apps/demo/packages/shop/tokens/${id}`, { method: "DELETE", token: ADMIN })).status).toBe(204);
        expect((await request(`/apps/demo/packages/shop/tokens/${id}`, { method: "DELETE", token: ADMIN })).status).toBe(404);
        expect((await request("/demo/shop/1/releases", { token })).status).toBe(401);
    });
});
