import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdtemp,
	realpath,
	rm,
	mkdir,
	writeFile,
	readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
	withTargetLock,
	stackOwnershipRegistryPath,
	snapshotTarget,
	reconcileTarget,
} from "../src/engine/target-registry.ts";
const moduleUrl = pathToFileURL(
	new URL("../src/engine/target-registry.ts", import.meta.url).pathname,
).href;
const target = { host: "203.0.113.10", user: "root", port: 22 };
const old = {
	machineIdHash: "a".repeat(64),
	machineIdMtime: "2026-09-01T00:00:00.000Z",
};
const fresh = {
	machineIdHash: "b".repeat(64),
	machineIdMtime: "2026-09-08T00:00:01.000Z",
};
const observation = {
	...fresh,
	ip: target.host,
	services: [],
	containers: [],
	volumes: [],
	dockerPresent: false,
	dataDirectoriesAbsent: true,
};
async function home(t) {
	const h = await mkdtemp(join(await realpath(tmpdir()), "registry-process-"));
	t.after(() => rm(h, { recursive: true, force: true }));
	return h;
}
function child(script, env = {}) {
	return spawn(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
}
test("OS releases target lock after holder process is killed", async (t) => {
	const h = await home(t);
	const c = child(
		`import {withTargetLock} from ${JSON.stringify(moduleUrl)};await withTargetLock(${JSON.stringify(target)},async()=>{console.log('locked');setInterval(()=>{},1000);await new Promise(()=>{});},${JSON.stringify(h)});setInterval(()=>{},1000);`,
	);
	t.after(() => c.kill());
	await once(c.stdout, "data");
	await assert.rejects(
		withTargetLock(target, async () => assert.fail(), h),
		/lock/,
	);
	const ended = once(c, "exit");
	c.kill("SIGKILL");
	await ended;
	let acquired = false;
	await withTargetLock(
		target,
		async () => {
			acquired = true;
		},
		h,
	);
	assert.equal(acquired, true);
});
test("real process death after rename recovers durable journal and full archive", async (t) => {
	const h = await home(t);
	const path = stackOwnershipRegistryPath(target, h);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, '{"n8n":"old","extra":"other"}');
	const req = {
		schemaVersion: 1,
		cycleId: "death",
		entornoId: "env",
		instanceId: "123",
		target,
	};
	const snapshot = await snapshotTarget(req, {
		home: h,
		observe: async () => ({ ...observation, ...old }),
	});
	const input = {
		...req,
		snapshot,
		receipt: { ...req, ...fresh, reinstalledAt: "2026-09-08T00:00:00.000Z" },
	};
	const c = child(
		`import {reconcileTarget} from ${JSON.stringify(moduleUrl)};await reconcileTarget(${JSON.stringify(input)},{home:${JSON.stringify(h)},observe:async()=>(${JSON.stringify(observation)}),afterArchive:()=>process.kill(process.pid,'SIGKILL')});`,
	);
	const [code, signal] = await once(c, "exit");
	assert.equal(code, null);
	assert.equal(signal, "SIGKILL");
	const result = await reconcileTarget(input, {
		home: h,
		observe: async () => observation,
	});
	assert.equal(result.sourceHash, result.archiveHash);
	assert.equal(
		await readFile(
			join(dirname(path), "cycles", "death", "archive.json"),
			"utf8",
		),
		'{"n8n":"old","extra":"other"}',
	);
});
test("actual apply entry point loses shared lock before rendering or writing secrets", async (t) => {
	const h = await home(t);
	const apply = new URL("../src/engine/apply.ts", import.meta.url).href;
	await withTargetLock(
		target,
		async () => {
			const c = child(
				`import {applyRecipe} from ${JSON.stringify(apply)};try{await applyRecipe({id:'x',apps:[]},{project:'same',domain:'example.test',target:${JSON.stringify(target)},execute:true});process.exitCode=2;}catch(e){if(!e.message.includes('lock'))throw e;console.log('blocked');}`,
				{ HOME: h },
			);
			let out = "";
			c.stdout.on("data", (b) => (out += b));
			const [code] = await once(c, "exit");
			assert.equal(code, 0);
			assert.equal(out.trim(), "blocked");
		},
		join(h, ".inventos"),
	);
});
