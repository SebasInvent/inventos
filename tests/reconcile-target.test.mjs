import assert from "node:assert/strict";
import test from "node:test";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	symlink,
	rm,
	access,
	realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as engine from "../src/engine/target-registry.ts";
const target = { user: "root", host: "203.0.113.10", port: 22 };
const old = {
	machineIdHash: "a".repeat(64),
	machineIdMtime: "2026-09-01T00:00:00.000Z",
};
const fresh = {
	machineIdHash: "b".repeat(64),
	machineIdMtime: "2026-09-08T00:00:01.000Z",
};
async function fixture(t) {
	const home = await mkdtemp(join(await realpath(tmpdir()), "registry-"));
	t.after(() => rm(home, { recursive: true, force: true }));
	const path = engine.stackOwnershipRegistryPath(target, home);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify({ n8n: "previous", extra: "other" }));
	await mkdir(join(home, "carlos"));
	await writeFile(join(home, "carlos", "secrets.json"), "private-control");
	const request = {
		schemaVersion: 1,
		cycleId: "cycle-1",
		entornoId: "env-1",
		instanceId: "123",
		target,
	};
	let observation = {
		...old,
		ip: target.host,
		services: [],
		containers: [],
		volumes: [],
		dockerPresent: false,
		dataDirectoriesAbsent: true,
	};
	const options = { home, observe: async () => observation };
	const snapshot = await engine.snapshotTarget(request, options);
	observation = { ...observation, ...fresh };
	const receipt = {
		...request,
		...fresh,
		reinstalledAt: "2026-09-08T00:00:00.000Z",
	};
	return {
		home,
		path,
		request,
		snapshot,
		receipt,
		options,
		set: (v) => Object.assign(observation, v),
		input: () => ({ ...request, snapshot, receipt }),
	};
}
test("archive exact complete registry and preserve secrets; replay stable", async (t) => {
	const f = await fixture(t);
	const before = await readFile(f.path);
	const r = await engine.reconcileTarget(f.input(), f.options);
	assert.equal(r.sourceHash, r.archiveHash);
	assert.deepEqual(
		await readFile(join(dirname(f.path), "cycles", "cycle-1", "archive.json")),
		before,
	);
	await assert.rejects(access(f.path));
	assert.equal(
		await readFile(join(f.home, "carlos", "secrets.json"), "utf8"),
		"private-control",
	);
	assert.deepEqual(await engine.reconcileTarget(f.input(), f.options), r);
});
for (const [name, change] of Object.entries({
	sameGeneration: (f) => f.set(old),
	ip: (f) => f.set({ ip: "203.0.113.11" }),
	services: (f) => f.set({ services: ["s"] }),
	containers: (f) => f.set({ containers: ["c"] }),
	volumes: (f) => f.set({ volumes: ["v"] }),
	data: (f) => f.set({ dataDirectoriesAbsent: false }),
	instance: (f) => (f.receipt.instanceId = "456"),
	cycle: (f) => (f.receipt.cycleId = "other"),
	time: (f) => (f.receipt.reinstalledAt = fresh.machineIdMtime),
}))
	test(`reject ${name} without touching registry`, async (t) => {
		const f = await fixture(t);
		const before = await readFile(f.path);
		change(f);
		await assert.rejects(engine.reconcileTarget(f.input(), f.options));
		assert.deepEqual(await readFile(f.path), before);
	});
test("CAS rejects changed registry", async (t) => {
	const f = await fixture(t);
	await writeFile(f.path, '{"n8n":"new"}');
	await assert.rejects(engine.reconcileTarget(f.input(), f.options), /CAS/);
	assert.equal(await readFile(f.path, "utf8"), '{"n8n":"new"}');
});
for (const mode of ["corrupt", "symlink"])
	test(`snapshot rejects ${mode}`, async (t) => {
		const f = await fixture(t);
		if (mode === "corrupt") await writeFile(f.path, "{");
		else {
			await rm(f.path);
			await symlink(join(f.home, "carlos", "secrets.json"), f.path);
		}
		await assert.rejects(
			engine.snapshotTarget({ ...f.request, cycleId: "cycle-2" }, f.options),
		);
	});
test("replay refuses newly registered owner", async (t) => {
	const f = await fixture(t);
	await engine.reconcileTarget(f.input(), f.options);
	await writeFile(f.path, '{"n8n":"new"}');
	await assert.rejects(engine.reconcileTarget(f.input(), f.options));
	assert.equal(await readFile(f.path, "utf8"), '{"n8n":"new"}');
});
test("shared lock excludes apply while observation is suspended", async (t) => {
	const f = await fixture(t);
	let release;
	let entered;
	const gate = new Promise((r) => (release = r));
	const ready = new Promise((r) => (entered = r));
	const running = engine.reconcileTarget(f.input(), {
		...f.options,
		observe: async () => {
			entered();
			await gate;
			return {
				...fresh,
				ip: target.host,
				services: [],
				containers: [],
				volumes: [],
				dockerPresent: false,
				dataDirectoriesAbsent: true,
			};
		},
	});
	await ready;
	await assert.rejects(
		engine.withTargetLock(target, async () => assert.fail("loser ran"), f.home),
		/lock/,
	);
	release();
	await running;
});
test("journal recovers crash after archive rename", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		engine.reconcileTarget(f.input(), {
			...f.options,
			afterArchive: () => {
				throw Error("crash");
			},
		}),
		/crash/,
	);
	const r = await engine.reconcileTarget(f.input(), f.options);
	assert.equal(r.sourceHash, r.archiveHash);
});

test("absent registry is measured, recorded and replayable without fictional ownership", async (t) => {
	const f = await fixture(t);
	await rm(f.path);
	const request = { ...f.request, cycleId: "absent" };
	const snapshot = await engine.snapshotTarget(request, {
		...f.options,
		observe: async () => ({
			...old,
			ip: target.host,
			services: [],
			containers: [],
			volumes: [],
			dockerPresent: false,
			dataDirectoriesAbsent: true,
		}),
	});
	const result = await engine.reconcileTarget(
		{ ...request, snapshot, receipt: { ...f.receipt, ...request } },
		f.options,
	);
	assert.equal(result.sourceHash, null);
	assert.equal(result.archiveHash, null);
	await assert.rejects(access(f.path));
	assert.equal(
		await readFile(join(f.home, "carlos", "secrets.json"), "utf8"),
		"private-control",
	);
});
test("forged unstored snapshot cannot authorize archive", async (t) => {
	const f = await fixture(t);
	const request = {
		...f.input(),
		cycleId: "forged",
		snapshot: { ...f.snapshot, cycleId: "forged" },
		receipt: { ...f.receipt, cycleId: "forged" },
	};
	await assert.rejects(
		engine.reconcileTarget(request, f.options),
		/not recorded/,
	);
	assert.ok(await readFile(f.path));
});
test("unreadable registry is not absence even when process is root", async (t) => {
	const f = await fixture(t);
	const { chmod } = await import("node:fs/promises");
	await chmod(f.path, 0);
	t.after(() => chmod(f.path, 0o600).catch(() => {}));
	await assert.rejects(
		engine.snapshotTarget({ ...f.request, cycleId: "unreadable" }, f.options),
		/Unsafe/,
	);
});
test("symlink target directory cannot redirect registry into a project", async (t) => {
	const f = await fixture(t);
	const alias = join(f.home, "alias");
	await symlink(dirname(f.path), alias);
	await assert.rejects(
		engine.withTargetLock(target, async () => assert.fail(), alias),
		/Unsafe/,
	);
});
test("target traversal and changed port/user do not archive source", async (t) => {
	const f = await fixture(t);
	for (const other of [
		{ ...target, user: "../root" },
		{ ...target, host: "../host" },
		{ ...target, port: 2222 },
		{ ...target, user: "ubuntu" },
	])
		await assert.rejects(
			engine.reconcileTarget({ ...f.input(), target: other }, f.options),
		);
	assert.ok(await readFile(f.path));
});
test("same project slug in a different org cannot claim stacks or mutate owners", async (t) => {
	const f = await fixture(t);
	await rm(f.path);
	await engine.withTargetLock(
		target,
		() =>
			engine.assertStackOwnership(["n8n"], "same", target, {
				home: f.home,
				orgId: "org-a",
				workId: "a",
				instanceId: "123",
				generation: fresh,
			}),
		f.home,
	);
	const before = await readFile(f.path);
	await assert.rejects(
		engine.withTargetLock(
			target,
			() =>
				engine.assertStackOwnership(["n8n"], "same", target, {
					home: f.home,
					orgId: "org-b",
					workId: "b",
					instanceId: "123",
					generation: fresh,
				}),
			f.home,
		),
		/Organization/,
	);
	assert.deepEqual(await readFile(f.path), before);
});
test("existing generation cannot silently follow reimage in apply gate", async (t) => {
	const f = await fixture(t);
	await rm(f.path);
	await engine.withTargetLock(
		target,
		() =>
			engine.assertStackOwnership(["n8n"], "same", target, {
				home: f.home,
				generation: old,
			}),
		f.home,
	);
	await assert.rejects(
		engine.withTargetLock(
			target,
			() =>
				engine.assertStackOwnership(["n8n"], "same", target, {
					home: f.home,
					generation: fresh,
				}),
			f.home,
		),
		/generation changed/,
	);
});

test("unchanged generation is rejected even with matching observation and valid anchor", async (t) => {
	const f = await fixture(t);
	Object.assign(f.receipt, old, { reinstalledAt: "2026-08-31T23:59:59.000Z" });
	f.set(old);
	await assert.rejects(
		engine.reconcileTarget(f.input(), f.options),
		/Generation unchanged/,
	);
	assert.ok(await readFile(f.path));
});
test("ownership writer refuses writes outside shared target lock", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		engine.assertStackOwnership(["n8n"], "previous", target, { home: f.home }),
		/requires target lock/,
	);
});
