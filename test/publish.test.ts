import { describe, expect, it } from "vitest";
import { ADMIN, newKeyPair, publishPointer, request, setup, signedPackage, uploadContent } from "./helpers.ts";

describe("publishing and delivery", () => {
    it("serves what a package published: pointer without caching, content immutable and byte-exact", async () => {
        const p = await signedPackage();
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        expect((await request(`/${app}/production/${pkg}/1/current.json`)).status).toBe(404);

        await uploadContent(app, pkg, "1", p, token);
        const published = await publishPointer(app, "production", pkg, "1", p, token, 30);
        const publishedText = await published.text();
        expect(published.status, publishedText).toBe(200);
        expect(JSON.parse(publishedText)).toEqual({ version: p.version, rollout: 30, signature: p.signature });

        const pointer = await request(`/${app}/production/${pkg}/1/current.json`);
        expect(pointer.status).toBe(200);
        expect(pointer.headers.get("cache-control")).toBe("no-store");
        expect(await pointer.json()).toEqual({ version: p.version, rollout: 30, signature: p.signature });

        const manifest = await request(`/${app}/production/${pkg}/1/${p.version}/manifest.json`);
        expect(manifest.status).toBe(200);
        expect(manifest.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(new Uint8Array(await manifest.arrayBuffer())).toEqual(p.manifest);
        const home = await request(`/${app}/production/${pkg}/1/${p.version}/pages/home.bin`);
        expect(new TextDecoder().decode(await home.arrayBuffer())).toBe(`HOME-${p.version}`);
        // the channel is a pointer, not a place: another channel reads the same bytes even before it points there
        expect((await request(`/${app}/staging/${pkg}/1/${p.version}/pages/home.bin`)).status).toBe(200);
        expect((await request(`/${app}/staging/${pkg}/1/current.json`)).status).toBe(404);
    });

    it("refuses a pointer before its content, and content that disagrees with the manifest", async () => {
        const p = await signedPackage();
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        const early = await publishPointer(app, "production", pkg, "1", p, token);
        expect(early.status).toBe(409);
        expect(await early.text()).toContain("content first, pointer last");

        await request(`/${app}/${pkg}/1/${p.version}/manifest.json`, { method: "PUT", token, body: p.manifest as BodyInit });
        const missing = await publishPointer(app, "production", pkg, "1", p, token);
        expect(missing.status).toBe(409);
        expect(await missing.text()).toContain("pages/home.bin is not uploaded yet");

        const tampered = await signedPackage({ files: { "pages/home.bin": "HOME-x" }, key: { publicKey: p.publicKey, privateKey: p.privateKey } });
        for (const [path, bytes] of Object.entries(tampered.files)) {
            await request(`/${app}/${pkg}/1/${p.version}/${path}`, { method: "PUT", token, body: bytes as BodyInit });
        }
        const mismatch = await publishPointer(app, "production", pkg, "1", p, token);
        expect(mismatch.status).toBe(409);
        expect(await mismatch.text()).toContain("does not match manifest.hashes");
        expect((await request(`/${app}/production/${pkg}/1/current.json`)).status).toBe(404);
    });

    it("publishes a package with strings only once they are uploaded and match, and serves them", async () => {
        const p = await signedPackage({ i18n: { en: '{"hi":"Hi"}', zh: '{"hi":"你好"}' } });
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        await request(`/${app}/${pkg}/1/${p.version}/pages/home.bin`, { method: "PUT", token, body: p.files["pages/home.bin"] as BodyInit });
        await request(`/${app}/${pkg}/1/${p.version}/manifest.json`, { method: "PUT", token, body: p.manifest as BodyInit });
        const missing = await publishPointer(app, "production", pkg, "1", p, token);
        expect(missing.status).toBe(409);
        expect(await missing.text()).toContain("i18n/en.json is not uploaded yet");

        await uploadContent(app, pkg, "1", p, token);
        const published = await publishPointer(app, "production", pkg, "1", p, token);
        expect(published.status, await published.clone().text()).toBe(200);
        const zh = await request(`/${app}/production/${pkg}/1/${p.version}/i18n/zh.json`);
        expect(await zh.text()).toBe('{"hi":"你好"}');
    });

    it("refuses a manifest whose hashes leave out a string file", async () => {
        const p = await signedPackage({ i18n: { en: "{}" }, edit: (m) => { delete (m["hashes"] as Record<string, string>)["i18n/en.json"]; } });
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        await uploadContent(app, pkg, "1", p, token);
        const r = await publishPointer(app, "production", pkg, "1", p, token);
        expect(r.status).toBe(400);
        expect(await r.text()).toContain("hashes does not cover exactly the modules in pages and the i18n files");
    });

    it("refuses a default language without a file", async () => {
        const p = await signedPackage({ i18n: { en: "{}" }, edit: (m) => { (m["i18n"] as { default: string }).default = "fr"; } });
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        await uploadContent(app, pkg, "1", p, token);
        const r = await publishPointer(app, "production", pkg, "1", p, token);
        expect(r.status).toBe(400);
        expect(((await r.json()) as { error: string }).error).toContain('i18n default "fr" has no file');
    });

    it("keeps a version immutable: the same bytes again are fine, different ones are refused", async () => {
        const p = await signedPackage();
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        const first = await request(`/${app}/${pkg}/1/${p.version}/pages/home.bin`, { method: "PUT", token, body: p.files["pages/home.bin"] as BodyInit });
        expect(first.status).toBe(201);
        const again = await request(`/${app}/${pkg}/1/${p.version}/pages/home.bin`, { method: "PUT", token, body: p.files["pages/home.bin"] as BodyInit });
        expect(again.status).toBe(200);
        expect(await again.json()).toMatchObject({ existing: true });
        const other = await request(`/${app}/${pkg}/1/${p.version}/pages/home.bin`, { method: "PUT", token, body: "something else" });
        expect(other.status).toBe(409);
        const tooBig = await request(`/${app}/${pkg}/1/${p.version}/pages/big.bin`, { method: "PUT", token, body: new Uint8Array(1048577) as BodyInit });
        expect(tooBig.status).toBe(413);
    });

    it("verifies the signature with the registered key and the manifest against its path", async () => {
        const p = await signedPackage();
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        await uploadContent(app, pkg, "1", p, token);

        const flipped = p.signature.slice(0, 20) + (p.signature[20] === "A" ? "B" : "A") + p.signature.slice(21);
        const bad = await request(`/${app}/production/${pkg}/1/current.json`, { method: "PUT", token, json: { version: p.version, signature: flipped } });
        expect(bad.status).toBe(400);
        expect(await bad.text()).toContain("signature does not verify");

        // signed by another key: the manifest can claim any publicKey, only the registered one counts
        const impostor = await signedPackage({ key: await newKeyPair(), edit: (m) => { m["publicKey"] = p.publicKey; } });
        const imp = await request(`/${app}/production/${pkg}/1/current.json`, { method: "PUT", token, json: { version: impostor.version, signature: impostor.signature } });
        expect(imp.status).toBe(400);

        // a package for another name or host version cannot be published under this path
        const otherName = await signedPackage({ name: "orders", key: { publicKey: p.publicKey, privateKey: p.privateKey }, version: "v-other" });
        await uploadContent(app, pkg, "1", otherName, token);
        const wrongName = await publishPointer(app, "production", pkg, "1", otherName, token);
        expect(wrongName.status).toBe(400);
        expect(await wrongName.text()).toContain("is not the path package");
        const otherHostVersion = await signedPackage({ hostVersion: "2", key: { publicKey: p.publicKey, privateKey: p.privateKey }, version: "v-hv2" });
        await uploadContent(app, pkg, "1", otherHostVersion, token);
        expect(await (await publishPointer(app, "production", pkg, "1", otherHostVersion, token)).text()).toContain("hostVersion");

        // an App version is not a host version: refused in the path and in the signed manifest alike
        expect((await request(`/${app}/production/${pkg}/1.2.0/current.json`, { method: "PUT", token, json: { version: p.version, signature: p.signature } })).status).toBe(404);
        const semver = await signedPackage({ hostVersion: "1.2.0", key: { publicKey: p.publicKey, privateKey: p.privateKey }, version: "v-semver" });
        await uploadContent(app, pkg, "1", semver, token);
        expect(await (await publishPointer(app, "production", pkg, "1", semver, token)).text()).toContain("not a positive integer");

        // the pointer names one version, the manifest says another
        const cross = await request(`/${app}/production/${pkg}/1/current.json`, { method: "PUT", token, json: { version: "v-other", signature: p.signature } });
        expect(cross.status).toBe(400);
    });

    it("scopes tokens to their package and channels", async () => {
        const p = await signedPackage();
        const { app, pkg, token } = await setup({ publicKey: p.publicKey, channels: ["staging"] });
        const other = await signedPackage({ name: "orders" });
        const orders = await setup({ app, pkg: "orders", publicKey: other.publicKey });
        expect((await request(`/${app}/${pkg}/1/${p.version}/manifest.json`, { method: "PUT", token: orders.token, body: p.manifest as BodyInit })).status).toBe(401);
        expect((await request(`/${app}/${pkg}/1/${p.version}/manifest.json`, { method: "PUT", body: p.manifest as BodyInit })).status).toBe(401);
        await uploadContent(app, pkg, "1", p, token);
        expect((await publishPointer(app, "production", pkg, "1", p, token)).status).toBe(403);
        expect((await publishPointer(app, "staging", pkg, "1", p, orders.token)).status).toBe(401);
        expect((await publishPointer(app, "staging", pkg, "1", p, token)).status).toBe(200);
    });

    it("promotes and re-rolls out without re-uploading or re-signing; pointers never move back", async () => {
        const v1 = await signedPackage({ version: "v1", createdAt: "2026-09-22T10:00:00Z" });
        const key = { publicKey: v1.publicKey, privateKey: v1.privateKey };
        const v2 = await signedPackage({ version: "v2", createdAt: "2026-09-22T11:00:00Z", key });
        const { app, pkg, token } = await setup({ publicKey: v1.publicKey });
        await uploadContent(app, pkg, "1", v1, token);
        await uploadContent(app, pkg, "1", v2, token);
        expect((await publishPointer(app, "staging", pkg, "1", v1, token)).status).toBe(200);
        expect((await publishPointer(app, "staging", pkg, "1", v2, token)).status).toBe(200);

        // staging verified v2: production points at it, nothing is transferred again
        const promote = await request(`/${app}/production/${pkg}/1/pointer`, { method: "POST", token, json: { version: "v2", rollout: 10 } });
        const promoteText = await promote.text();
        expect(promote.status, promoteText).toBe(200);
        expect(JSON.parse(promoteText)).toEqual({ version: "v2", rollout: 10, signature: v2.signature });

        // wider rollout keeps the version and the signature
        const wider = await request(`/${app}/production/${pkg}/1/pointer`, { method: "POST", token, json: { rollout: 100 } });
        expect(await wider.json()).toEqual({ version: "v2", rollout: 100, signature: v2.signature });

        // a rollback is a new version, never a pointer moved back: neither promote nor publish goes backwards
        const back = await request(`/${app}/production/${pkg}/1/pointer`, { method: "POST", token, json: { version: "v1" } });
        expect(back.status).toBe(409);
        expect(await back.text()).toContain("only move forward");
        expect((await publishPointer(app, "staging", pkg, "1", v1, token)).status).toBe(409);
        expect((await publishPointer(app, "staging", pkg, "1", v2, token)).status, "the same version again is not a move").toBe(200);
        expect(await (await request(`/${app}/production/${pkg}/1/current.json`)).json()).toEqual({ version: "v2", rollout: 100, signature: v2.signature });

        expect((await request(`/${app}/production/${pkg}/1/pointer`, { method: "POST", token, json: { version: "v9" } })).status).toBe(404);
        expect((await request(`/${app}/production/${pkg}/1/pointer`, { method: "POST", token, json: { version: "v2", rollout: 101 } })).status).toBe(400);

        const releases = await request(`/${app}/${pkg}/1/releases`, { token });
        const listed = (await releases.json()) as { versions: { version: string }[]; channels: Record<string, { version: string; rollout: number }> };
        expect(listed.versions.map((v) => v.version)).toEqual(["v2", "v1"]);
        expect(listed.channels).toEqual({ staging: { version: "v2", rollout: 100 }, production: { version: "v2", rollout: 100 } });
    });

    it("never leaves a pointer behind a published version, even when publishes race", async () => {
        const v1 = await signedPackage({ version: "r1", createdAt: "2026-09-22T10:00:00Z" });
        const key = { publicKey: v1.publicKey, privateKey: v1.privateKey };
        const v2 = await signedPackage({ version: "r2", createdAt: "2026-09-22T11:00:00Z", key });
        const v3 = await signedPackage({ version: "r3", createdAt: "2026-09-22T12:00:00Z", key });
        const { app, pkg, token } = await setup({ publicKey: v1.publicKey });
        for (const p of [v1, v2, v3]) await uploadContent(app, pkg, "1", p, token);
        expect((await publishPointer(app, "staging", pkg, "1", v1, token)).status).toBe(200);

        const [r2, r3] = await Promise.all([publishPointer(app, "staging", pkg, "1", v2, token), publishPointer(app, "staging", pkg, "1", v3, token)]);
        const landed = (await (await request(`/${app}/staging/${pkg}/1/current.json`)).json()) as { version: string };
        const accepted = [r2.status === 200 && "r2", r3.status === 200 && "r3"].filter(Boolean) as string[];
        expect(accepted.length).toBeGreaterThan(0);
        // whatever raced, the pointer is at the newest version any request was told it published
        expect(landed.version).toBe(accepted.sort().at(-1));
        for (const r of [r2, r3]) expect([200, 409]).toContain(r.status);
    });

    it("refuses a createdAt that is not one real instant in the one form", async () => {
        const p = await signedPackage({ createdAt: "2026-09-22T10:00:00.500Z" });
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        await uploadContent(app, pkg, "1", p, token);
        const response = await publishPointer(app, "staging", pkg, "1", p, token);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("createdAt is not a real YYYY-MM-DDTHH:MM:SSZ instant");

        const impossible = await signedPackage({ version: "impossible", createdAt: "2026-02-30T10:00:00Z", key: { publicKey: p.publicKey, privateKey: p.privateKey } });
        await uploadContent(app, pkg, "1", impossible, token);
        expect((await publishPointer(app, "staging", pkg, "1", impossible, token)).status).toBe(400);
    });

    it("accepts a package tinyui bundle signed with Node's crypto", async () => {
        // the same fixture the Kotlin client verifies (tinyui updates/src/commonTest Fixture.kt)
        const publicKey = "BEbccwd4v7RnidrsHeZ6qqJF+yNy4DTEe/JHkHL470V74M9sYGxpekukLlpXv2qrru7ptyfKS1c7eC26sn7wKdI=";
        const signature = "MEUCIQCFnOw6pTRT9OYOsp/tdMzCD9DB8SnFmjop2KssJl0QEwIgXr0EWLdYlxagsjCVFwz0GTP5UZBlI0U1pGcQMWzOjuw=";
        const version = "20260922T100000Z-abcdef1";
        const manifest = [
            "{",
            '  "pages": [',
            '    "shop/home"',
            "  ],",
            '  "files": {',
            '    "shop/home": "pages/home"',
            "  },",
            '  "buildIds": {',
            '    "shop/home": "cccccccc"',
            "  },",
            '  "name": "shop",',
            `  "publicKey": "${publicKey}",`,
            `  "version": "${version}",`,
            '  "createdAt": "2026-09-22T10:00:00Z",',
            '  "engine": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",',
            '  "tinyui": "0.5.0",',
            '  "hashes": {',
            '    "shop/home": "6ca9202ab8e55afbd5f0e68113ef733655c190b1531cc7e1fc17ea3bb8d32230"',
            "  },",
            '  "hostVersion": "1"',
            "}",
            "",
        ].join("\n");
        const { app, pkg, token } = await setup({ publicKey });
        for (const [path, text] of Object.entries({ "pages/home.bin": "HOME2" })) {
            expect((await request(`/${app}/${pkg}/1/${version}/${path}`, { method: "PUT", token, body: text })).status).toBe(201);
        }
        expect((await request(`/${app}/${pkg}/1/${version}/manifest.json`, { method: "PUT", token, body: manifest })).status).toBe(201);
        const published = await request(`/${app}/production/${pkg}/1/current.json`, { method: "PUT", token, json: { version, signature } });
        const publishedText = await published.text();
        expect(published.status, publishedText).toBe(200);
        expect(await (await request(`/${app}/production/${pkg}/1/current.json`)).json()).toEqual({ version, rollout: 100, signature });
    });

    it("keeps a version immutable under concurrent uploads, and lists concurrent publishes completely", async () => {
        const v1 = await signedPackage({ version: "v1", createdAt: "2026-09-22T10:00:00Z" });
        const key = { publicKey: v1.publicKey, privateKey: v1.privateKey };
        const v2 = await signedPackage({ version: "v2", createdAt: "2026-09-22T11:00:00Z", key });
        const { app, pkg, token } = await setup({ publicKey: v1.publicKey });

        // two different bodies race for one path: exactly one wins, the other is told so
        const race = await Promise.all(["one", "two"].map((body) => request(`/${app}/${pkg}/1/v1/pages/race.bin`, { method: "PUT", token, body })));
        expect(race.map((r) => r.status).sort()).toEqual([201, 409]);

        await uploadContent(app, pkg, "1", v1, token);
        await uploadContent(app, pkg, "1", v2, token);
        // two versions published at once to two channels: each is its own document, nothing is lost
        const published = await Promise.all([publishPointer(app, "staging", pkg, "1", v1, token), publishPointer(app, "production", pkg, "1", v2, token)]);
        expect(published.map((r) => r.status)).toEqual([200, 200]);
        const listed = (await (await request(`/${app}/${pkg}/1/releases`, { token })).json()) as { versions: { version: string }[]; channels: Record<string, { version: string }> };
        expect(listed.versions.map((v) => v.version)).toEqual(["v2", "v1"]);
        expect(Object.keys(listed.channels).sort()).toEqual(["production", "staging"]);
    });

    it("rejects paths that are not names or segments", async () => {
        const p = await signedPackage();
        const { app, pkg, token } = await setup({ publicKey: p.publicKey });
        expect((await request(`/${app}/${pkg}/1/../manifest.json`, { method: "PUT", token, body: "x" })).status).not.toBe(201);
        expect((await request(`/${app}/${pkg}/1/v1/..%2Fescape.bin`, { method: "PUT", token, body: "x" })).status).toBe(404);
        expect((await request(`/${app}/Prod/${pkg}/1/current.json`)).status).toBe(404);
        // `apps` is reserved: never served as an app
        expect((await request(`/apps/production/${pkg}/1/current.json`)).status).toBe(404);
        expect((await request(`/${app}/production/${pkg}/1/current.json`, { method: "PUT", token: ADMIN, json: {} })).status).toBe(401);
    });
});
