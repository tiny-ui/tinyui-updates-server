import { describe, expect, it } from "vitest";
import { ADMIN, newKeyPair, request, setup } from "./helpers.ts";

async function appToken(app: string): Promise<{ id: string; token: string }> {
    const r = await request(`/apps/${app}/tokens`, { method: "POST", token: ADMIN });
    expect(r.status).toBe(201);
    return (await r.json()) as { id: string; token: string };
}

describe("app tokens", () => {
    it("are minted and revoked by the admin token only", async () => {
        const { app } = await setup({ publicKey: (await newKeyPair()).publicKey });
        const { id, token } = await appToken(app);
        // an app token cannot extend its own life: no minting peers, no revoking them
        expect((await request(`/apps/${app}/tokens`, { method: "POST", token })).status).toBe(401);
        expect((await request(`/apps/${app}/tokens/${id}`, { method: "DELETE", token })).status).toBe(401);
        expect((await request(`/apps/nowhere/tokens`, { method: "POST", token: ADMIN })).status).toBe(404);
        expect((await request(`/apps/${app}/tokens/${id}`, { method: "DELETE", token: ADMIN })).status).toBe(204);
        expect((await request(`/apps/${app}/tokens/${id}`, { method: "DELETE", token: ADMIN })).status).toBe(404);
        // revoked is gone at once
        expect((await request(`/apps/${app}/packages`, { method: "POST", token, json: { name: "late", publicKey: (await newKeyPair()).publicKey } })).status).toBe(401);
    });

    it("manage their own app: packages, keys, publish tokens, releases", async () => {
        const key = await newKeyPair();
        const { app, pkg } = await setup({ publicKey: key.publicKey });
        const { token } = await appToken(app);
        expect((await request(`/apps/${app}/packages`, { method: "POST", token, json: { name: "orders", publicKey: key.publicKey } })).status).toBe(201);
        expect((await request(`/apps/${app}/packages/orders/publicKey`, { method: "PUT", token, json: { publicKey: (await newKeyPair()).publicKey } })).status).toBe(200);
        const issued = await request(`/apps/${app}/packages/${pkg}/tokens`, { method: "POST", token, json: { channels: ["staging"] } });
        expect(issued.status).toBe(201);
        const { id } = (await issued.json()) as { id: string };
        expect((await request(`/apps/${app}/packages/${pkg}/tokens/${id}`, { method: "DELETE", token })).status).toBe(204);
        expect((await request(`/${app}/${pkg}/1/releases`, { token })).status).toBe(200);
        // it is not a publish token: publishing still takes the package's own token and the signed manifest
        expect((await request(`/${app}/staging/${pkg}/1/current.json`, { method: "PUT", token, json: { version: "v", signature: "s" } })).status).toBe(401);
    });

    it("reach no other app, and create none", async () => {
        const key = await newKeyPair();
        const mine = await setup({ publicKey: key.publicKey });
        const theirs = await setup({ publicKey: key.publicKey });
        const { token } = await appToken(mine.app);
        expect((await request("/apps", { method: "POST", token, json: { id: "grabbed", name: "Grabbed" } })).status).toBe(401);
        expect((await request(`/apps/${theirs.app}/packages`, { method: "POST", token, json: { name: "x", publicKey: key.publicKey } })).status).toBe(401);
        expect((await request(`/apps/${theirs.app}/packages/${theirs.pkg}/tokens`, { method: "POST", token, json: { channels: ["production"] } })).status).toBe(401);
        expect((await request(`/apps/${theirs.app}/hosts/1`, { method: "PUT", token, body: "host 1" })).status).toBe(401);
        expect((await request(`/${theirs.app}/${theirs.pkg}/1/releases`, { token })).status).toBe(401);
        // a publish token is not a manager either
        expect((await request(`/apps/${mine.app}/packages`, { method: "POST", token: mine.token, json: { name: "x", publicKey: key.publicKey } })).status).toBe(401);
    });
});

describe("host snapshots", () => {
    it("are written once per host version by the admin or an app token", async () => {
        const { app, token: publishToken } = await setup({ publicKey: (await newKeyPair()).publicKey });
        const { token } = await appToken(app);
        const put = await request(`/apps/${app}/hosts/1`, { method: "PUT", token, body: "hostVersion 1\ncapabilities\n  checkout.start\n" });
        expect(put.status).toBe(201);
        expect(await put.json()).toMatchObject({ hostVersion: "1", existing: false });
        const again = await request(`/apps/${app}/hosts/1`, { method: "PUT", token: ADMIN, body: "hostVersion 1\ncapabilities\n  checkout.start\n" });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ existing: true });
        // a shipped host version is frozen
        const changed = await request(`/apps/${app}/hosts/1`, { method: "PUT", token, body: "hostVersion 1\ncapabilities\n  coupon.apply\n" });
        expect(changed.status).toBe(409);
        // a publish token reads them but cannot write them
        expect((await request(`/apps/${app}/hosts/2`, { method: "PUT", token: publishToken, body: "x" })).status).toBe(401);
        expect((await request(`/apps/${app}/hosts/2`, { method: "PUT", token, body: "" })).status).toBe(400);
        expect((await request(`/apps/${app}/hosts/1.2.0`, { method: "PUT", token, body: "x" })).status).toBe(404);
    });

    it("are read back byte for byte by any token of the app, and by nobody else", async () => {
        const key = await newKeyPair();
        const mine = await setup({ publicKey: key.publicKey });
        const theirs = await setup({ publicKey: key.publicKey });
        const snapshot = "hostVersion 3\ntinyui 0.3.0\ncomponents\n  ta.Icon\n";
        expect((await request(`/apps/${mine.app}/hosts/3`, { method: "PUT", token: ADMIN, body: snapshot })).status).toBe(201);
        const read = await request(`/apps/${mine.app}/hosts/3`, { token: mine.token });
        expect(read.status).toBe(200);
        expect(await read.text()).toBe(snapshot);
        expect((await request(`/apps/${mine.app}/hosts/3`, { token: (await appToken(mine.app)).token })).status).toBe(200);
        expect((await request(`/apps/${mine.app}/hosts/3`, { token: theirs.token })).status).toBe(401);
        expect((await request(`/apps/${mine.app}/hosts/3`)).status).toBe(401);
        const missing = await request(`/apps/${mine.app}/hosts/4`, { token: mine.token });
        expect(missing.status).toBe(404);
        expect(await missing.text()).toContain("has no snapshot");
    });
});
