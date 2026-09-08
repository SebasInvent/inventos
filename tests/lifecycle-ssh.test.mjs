import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	mkdtemp,
	realpath,
	readFile,
	writeFile,
	mkdir,
	rm,
	stat,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { createServer, createConnection } from "node:net";
import {
	snapshotTarget,
	inspectTarget,
	reconcileTarget,
	stackOwnershipRegistryPath,
} from "../src/engine/target-registry.ts";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
	const s = createServer();
	s.listen(0, "127.0.0.1");
	await once(s, "listening");
	const port = s.address().port;
	await new Promise((r) => s.close(r));
	return port;
}
async function ready(port) {
	for (let n = 0; n < 100; n++) {
		if (
			await new Promise((resolve) => {
				const s = createConnection({ host: "127.0.0.1", port });
				s.on("connect", () => {
					s.destroy();
					resolve(true);
				});
				s.on("error", () => resolve(false));
			})
		)
			return;
		await delay(20);
	}
	throw Error("local sshd did not listen");
}
async function stop(p) {
	if (!p || p.exitCode !== null) return;
	const ended = once(p, "exit");
	p.kill("SIGTERM");
	await ended;
}
function deepReverse(x) {
	return x && typeof x === "object" && !Array.isArray(x)
		? Object.fromEntries(
				Object.entries(x)
					.reverse()
					.map(([k, v]) => [k, deepReverse(v)]),
			)
		: x;
}
test("real OpenSSH pins one authorized generation per cycle, survives JSON reorder and rejects changed/corrupt keys", async (t) => {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "inventos-ssh-"));
	const home = join(dir, "state");
	const agent = spawn(
		"/usr/bin/ssh-agent",
		["-D", "-a", join(dir, "agent.sock")],
		{ stdio: "ignore" },
	);
	let server;
	const previousSock = process.env.SSH_AUTH_SOCK;
	process.env.SSH_AUTH_SOCK = join(dir, "agent.sock");
	t.after(async () => {
		await stop(server);
		await stop(agent);
		if (previousSock === undefined) delete process.env.SSH_AUTH_SOCK;
		else process.env.SSH_AUTH_SOCK = previousSock;
		await rm(dir, { recursive: true, force: true });
	});
	for (const key of ["host-a", "host-b", "client"])
		execFileSync("/usr/bin/ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-f",
			join(dir, key),
		]);
	for (let n = 0; n < 100; n++) {
		try {
			await stat(join(dir, "agent.sock"));
			break;
		} catch {
			await delay(20);
		}
	}
	execFileSync("/usr/bin/ssh-add", [join(dir, "client")], { stdio: "ignore" });
	const port = await freePort();
	const target = { host: "127.0.0.1", user: userInfo().username, port };
	const req = {
		schemaVersion: 1,
		cycleId: "cycle-a",
		entornoId: "env",
		instanceId: "123",
		target,
	};
	const previous = {
		machineIdHash: "a".repeat(64),
		machineIdMtime: "2026-09-01T00:00:00.000Z",
	};
	const current = {
		machineIdHash: "b".repeat(64),
		machineIdMtime: "2026-09-08T00:00:01.000Z",
	};
	const observation = {
		...previous,
		ip: target.host,
		services: [],
		containers: [],
		volumes: [],
		dockerPresent: false,
		dataDirectoriesAbsent: true,
	};
	const response = join(dir, "response");
	const config = join(dir, "sshd.conf");
	async function respond(machine) {
		await writeFile(
			response,
			`machineIdHash=${machine.machineIdHash}\nmachineIdMtime=${Date.parse(machine.machineIdMtime) / 1000}\nip=127.0.0.1\ndockerPresent=false\nservices=\ncontainers=\nvolumes=\ndataDirectoriesAbsent=true\n`,
		);
	}
	async function start(key) {
		await writeFile(
			config,
			`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(dir, key)}\nPidFile ${join(dir, "sshd.pid")}\nAuthorizedKeysFile ${join(dir, "client.pub")}\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nLogLevel ERROR\nForceCommand /bin/cat ${response}\n`,
		);
		server = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], {
			stdio: "ignore",
		});
		await ready(port);
	}
	await respond(previous);
	await start("host-a");
	// Snapshot never accepts a new host key. Setup below injects only the previous observation.
	await assert.rejects(
		snapshotTarget(req, { home }),
		/Target observation failed/,
	);
	const path = stackOwnershipRegistryPath(target, home);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, '{"n8n":"old","other":"other"}');
	const snapshot = await snapshotTarget(req, {
		home,
		observe: async () => observation,
	});
	const authorization = { ...req, reinstalledAt: "2026-09-08T00:00:00.000Z" };
	await assert.rejects(inspectTarget(req, { home }), /authorization/);
	const early = await inspectTarget({ ...req, authorization }, { home });
	assert.equal(early.machineIdHash, previous.machineIdHash);
	await assert.rejects(
		readFile(join(dirname(path), "cycles", req.cycleId, "known_hosts")),
	);
	await stop(server);
	await respond(current);
	await start("host-b");
	const inspected = await inspectTarget({ ...req, authorization }, { home });
	assert.equal(inspected.machineIdHash, current.machineIdHash);
	const cycleDir = join(dirname(path), "cycles", req.cycleId);
	const known = join(cycleDir, "known_hosts");
	const pinned = await readFile(known);
	assert.ok(pinned.length > 0);
	assert.equal((await stat(known)).mode & 0o777, 0o600);
	const result = await reconcileTarget(
		{
			...req,
			snapshot: deepReverse(snapshot),
			receipt: deepReverse({ ...authorization, ...current }),
		},
		{ home },
	);
	assert.equal(result.sourceHash, result.archiveHash);
	assert.deepEqual(
		await inspectTarget(
			{ ...req, authorization: deepReverse(authorization) },
			{ home },
		),
		inspected,
	);
	await stop(server);
	await start("host-a");
	await assert.rejects(
		inspectTarget({ ...req, authorization }, { home }),
		/observation failed/,
	);
	assert.deepEqual(await readFile(known), pinned);
	const next = { ...req, cycleId: "cycle-b" };
	await snapshotTarget(next, {
		home,
		observe: async () => ({ ...observation, ...current }),
	});
	const later = {
		machineIdHash: "c".repeat(64),
		machineIdMtime: "2026-09-09T00:00:01.000Z",
	};
	await respond(later);
	const nextAuthorization = {
		...next,
		reinstalledAt: "2026-09-09T00:00:00.000Z",
	};
	assert.equal(
		(
			await inspectTarget(
				{ ...next, authorization: nextAuthorization },
				{ home },
			)
		).machineIdHash,
		later.machineIdHash,
	);
	assert.notDeepEqual(
		await readFile(join(dirname(path), "cycles", next.cycleId, "known_hosts")),
		pinned,
	);
	await writeFile(known, "corrupt host record");
	await assert.rejects(
		inspectTarget({ ...req, authorization }, { home }),
		/evidence changed/,
	);
	assert.equal(await readFile(known, "utf8"), "corrupt host record");
});
