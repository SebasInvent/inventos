import test from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp,
	realpath,
	mkdir,
	writeFile,
	readFile,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
	snapshotTarget,
	inspectTarget,
	stackOwnershipRegistryPath,
} from "../src/engine/target-registry.ts";
test("spawned SSH argv scopes trust to authorized cycle and preserves it on ubuntu fallback", async (t) => {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "ssh-argv-"));
	const bin = join(dir, "bin");
	await mkdir(bin);
	const pathBefore = process.env.PATH;
	const timeBefore = process.env.ARGV_MACHINE_TIME;
	const hashBefore = process.env.ARGV_MACHINE_HASH;
	t.after(async () => {
		process.env.PATH = pathBefore;
		for (const [k, v] of [
			["ARGV_MACHINE_TIME", timeBefore],
			["ARGV_MACHINE_HASH", hashBefore],
		]) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		await rm(dir, { recursive: true, force: true });
	});
	execFileSync("/usr/bin/ssh-keygen", [
		"-q",
		"-t",
		"ed25519",
		"-N",
		"",
		"-f",
		join(dir, "host"),
	]);
	const pub = (await readFile(join(dir, "host.pub"), "utf8"))
		.trim()
		.split(" ")
		.slice(0, 2)
		.join(" ");
	const log = join(dir, "argv.jsonl");
	await writeFile(
		join(bin, "ssh"),
		`#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const opt=args.find(a=>a.startsWith('UserKnownHostsFile='));if(opt){const file=opt.slice('UserKnownHostsFile='.length).replace(/^"|"$/g,'');if(!fs.readFileSync(file,'utf8'))fs.writeFileSync(file,${JSON.stringify("192.0.2.1 " + pub + "\n")});}
if(args.includes('root@192.0.2.1'))process.exit(255);
process.stdout.write('machineIdHash='+process.env.ARGV_MACHINE_HASH+'\\nmachineIdMtime='+process.env.ARGV_MACHINE_TIME+'\\nip=192.0.2.1\\ndockerPresent=false\\nservices=\\ncontainers=\\nvolumes=\\ndataDirectoriesAbsent=true\\n');
`,
		{ mode: 0o700 },
	);
	process.env.PATH = bin + ":" + pathBefore;
	process.env.ARGV_MACHINE_HASH = "a".repeat(64);
	process.env.ARGV_MACHINE_TIME = "1788220800";
	const home = join(dir, "state");
	const target = { host: "192.0.2.1", user: "root", port: 22 };
	const req = {
		schemaVersion: 1,
		cycleId: "argv-cycle",
		entornoId: "env",
		instanceId: "123",
		target,
	};
	const snapshot = await snapshotTarget(req, { home });
	assert.equal(snapshot.previousMachine.machineIdHash, "a".repeat(64));
	const before = (await readFile(log, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.equal(before.length, 2);
	for (const args of before) {
		assert.ok(args.includes("StrictHostKeyChecking=yes"));
		assert.ok(!args.some((a) => a.startsWith("UserKnownHostsFile=")));
		assert.ok(!args.includes("StrictHostKeyChecking=accept-new"));
	}
	process.env.ARGV_MACHINE_HASH = "b".repeat(64);
	process.env.ARGV_MACHINE_TIME = "1788825601";
	const authorization = { ...req, reinstalledAt: "2026-09-08T00:00:00.000Z" };
	const corrupt = join(
		dirname(stackOwnershipRegistryPath(target, home)),
		"cycles",
		"argv-cycle",
		"known_hosts",
	);
	await writeFile(corrupt, "invalid known hosts");
	await assert.rejects(
		inspectTarget({ ...req, authorization }, { home }),
		/Corrupt private known_hosts/,
	);
	assert.equal(await readFile(corrupt, "utf8"), "invalid known hosts");
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
	await rm(corrupt);
	await inspectTarget(
		{
			...req,
			authorization,
			target: { ...target, sshOptions: ["StrictHostKeyChecking=no"] },
		},
		{ home },
	);
	const calls = (await readFile(log, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse)
		.slice(2);
	assert.equal(calls.length, 2);
	const privateFile = join(
		dirname(stackOwnershipRegistryPath(target, home)),
		"cycles",
		"argv-cycle",
		"known_hosts",
	);
	for (const args of calls) {
		assert.ok(args.includes("StrictHostKeyChecking=accept-new"));
		assert.ok(args.includes('UserKnownHostsFile="' + privateFile + '"'));
		assert.ok(args.includes("GlobalKnownHostsFile=/dev/null"));
		assert.ok(args.includes("UpdateHostKeys=no"));
		assert.ok(!args.includes("StrictHostKeyChecking=no"));
	}
	assert.ok(calls[0].includes("root@192.0.2.1"));
	assert.ok(calls[1].includes("ubuntu@192.0.2.1"));
	assert.match(calls[1].at(-1), /^sudo -n env SSH_CONNECTION=/);
	const count = calls.length;
	await assert.rejects(
		inspectTarget(
			{ ...req, authorization: { ...authorization, cycleId: "other" } },
			{ home },
		),
		/mismatch/,
	);
	assert.equal(
		(await readFile(log, "utf8")).trim().split("\n").length,
		before.length + count,
	);
});
