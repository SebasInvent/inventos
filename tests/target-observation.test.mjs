import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	TARGET_OBSERVATION_SCRIPT,
	parseObservation,
} from "../src/engine/target-registry.ts";
async function probe(t, env = {}, docker = true) {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "probe-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	for (const [name, script] of Object.entries({
		cat: "printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		stat: "printf '%s\\n' 1788825601",
		sha256sum: "/usr/bin/shasum -a 256",
		...(docker
			? {
					docker: `case "$1" in
info) [ "\${PROBE_FAIL:-}" != info ] || exit 1; printf '%s\\n' active;;
service) [ "\${PROBE_FAIL:-}" != service ] || exit 1; printf '%s' "\${PROBE_SERVICES:-}";;
ps) [ "\${PROBE_FAIL:-}" != ps ] || exit 1; printf '%s' "\${PROBE_CONTAINERS:-}";;
volume) [ "\${PROBE_FAIL:-}" != volume ] || exit 1; printf '%s' "\${PROBE_VOLUMES:-}";;
*) exit 2;; esac`,
				}
			: {}),
	})) {
		await writeFile(join(dir, name), "#!/bin/sh\n" + script + "\n", {
			mode: 0o700,
		});
	}
	return spawnSync("/bin/sh", ["-c", TARGET_OBSERVATION_SCRIPT], {
		env: {
			...process.env,
			PATH: dir + ":/usr/bin:/bin",
			SSH_CONNECTION: "198.51.100.1 5000 203.0.113.10 22",
			...env,
		},
		encoding: "utf8",
		timeout: 5000,
	});
}
test("real shell observation detects positive Docker services containers and volumes", async (t) => {
	const r = await probe(t, {
		PROBE_SERVICES: "svc",
		PROBE_CONTAINERS: "container",
		PROBE_VOLUMES: "volume",
	});
	assert.equal(r.status, 0, r.stderr);
	const o = parseObservation(r.stdout);
	assert.deepEqual(o.services, ["svc"]);
	assert.deepEqual(o.containers, ["container"]);
	assert.deepEqual(o.volumes, ["volume"]);
	assert.equal(o.ip, "203.0.113.10");
	assert.equal(o.dockerPresent, true);
});
for (const operation of ["info", "service", "ps", "volume"])
	test(`real shell propagates Docker ${operation} failure`, async (t) => {
		const r = await probe(t, { PROBE_FAIL: operation });
		assert.notEqual(r.status, 0);
		assert.throws(() => parseObservation(r.stdout));
	});
test("Docker absent is distinct from broken Docker and requires missing data dirs", async (t) => {
	const r = await probe(t, {}, false);
	assert.equal(r.status, 0, r.stderr);
	const o = parseObservation(r.stdout);
	assert.equal(o.dockerPresent, false);
	assert.equal(o.dataDirectoriesAbsent, true);
});
test("malformed output and booleans fail closed", async (t) => {
	const r = await probe(t);
	assert.equal(r.status, 0);
	parseObservation(r.stdout);
	for (const value of [
		r.stdout + "extra=1\n",
		r.stdout.replace("dockerPresent=true", "dockerPresent=unknown"),
		r.stdout.replace("containers=", "containers=???"),
	])
		assert.throws(() => parseObservation(value));
});
