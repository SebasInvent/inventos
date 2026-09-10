// Registry lifecycle: a clean disk does not authorize forgetting unobserved ownership.
// All writers use the same target lock, held across the complete apply or reconciliation.
import { isDeepStrictEqual, promisify } from "node:util";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, parse } from "node:path";
import { isIP } from "node:net";
import { createTarget } from "./target.ts";
const activeLock = new AsyncLocalStorage();
const defaultHome = () => join(homedir(), ".inventos");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => {
	throw new Error(message);
};
const id = (value) =>
	typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const digest = (value) =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function targetIdentity(target) {
	if (
		!target ||
		typeof target.host !== "string" ||
		!/^[a-zA-Z0-9.-]+$/.test(target.host) ||
		typeof target.user !== "string" ||
		!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(target.user) ||
		!Number.isInteger(target.port ?? 22) ||
		(target.port ?? 22) < 1 ||
		(target.port ?? 22) > 65535
	)
		fail("Invalid target");
	return {
		host: target.host.toLowerCase(),
		user: target.user,
		port: target.port ?? 22,
	};
}
/**
 * Where the last reconciled generation is recorded for a target.
 *
 * It lives NEXT TO the registry and not inside the cycle folder on purpose: the apply that follows a
 * cleaning cycle belongs to a DIFFERENT job — the release has its own cycleId and the new tenant's
 * install has another — so apply cannot look the receipt up by cycle. A marker beside the registry
 * is the only thing it can find without being told.
 */
export function reconciledGenerationPath(target, home = defaultHome()) {
	return join(dirname(stackOwnershipRegistryPath(target, home)), "generation.json");
}
export function stackOwnershipRegistryPath(target, home = defaultHome()) {
	const t = targetIdentity(target);
	return join(
		home,
		"targets",
		hash(`${t.user}@${t.host}:${t.port}`),
		"stacks.json",
	);
}
async function safeDirectory(path) {
	const full = resolve(path);
	let current = parse(full).root;
	for (const part of full.slice(current.length).split("/").filter(Boolean)) {
		current = join(current, part);
		try {
			await mkdir(current, { mode: 0o700 });
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
		}
		const s = await lstat(current);
		if (!s.isDirectory() || s.isSymbolicLink())
			fail("Unsafe registry directory");
	}
}
async function bytes(path) {
	try {
		const s = await lstat(path);
		if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o444) === 0)
			fail("Unsafe registry file");
		const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			return await fd.readFile();
		} finally {
			await fd.close();
		}
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}
function parsePrivate(raw) {
	try {
		return JSON.parse(raw.toString());
	} catch {
		fail("Corrupt private registry JSON");
	}
}
async function json(path) {
	const b = await bytes(path);
	return b === null ? null : parsePrivate(b);
}
async function syncDirectory(path) {
	const fd = await open(path, constants.O_RDONLY);
	try {
		await fd.sync();
	} finally {
		await fd.close();
	}
}
async function atomic(path, value) {
	const tmp = path + "." + randomUUID() + ".tmp";
	const f = await open(tmp, "wx", 0o600);
	try {
		await f.writeFile(JSON.stringify(value) + "\n");
		await f.sync();
	} finally {
		await f.close();
	}
	await rename(tmp, path);
	await syncDirectory(dirname(path));
}
export async function withTargetLock(target, fn, home = defaultHome()) {
	if (Number(process.versions.node.split(".")[0]) < 24)
		fail(
			"La reconciliación y apply requieren Node.js 24 o posterior (lock SQLite nativo).",
		);

	const dir = dirname(stackOwnershipRegistryPath(target, home));
	await safeDirectory(dir);
	const lock = join(dir, "operation.sqlite");
	// Open without following links before SQLite; same-UID/root filesystem attacks are outside the trust model.
	for (const path of [lock, lock + "-journal", lock + "-wal", lock + "-shm"])
		await bytes(path);
	const fd = await open(
		lock,
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600,
	);
	await fd.close();
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(lock);
	try {
		try {
			db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
		} catch {
			fail("Target lock occupied");
		}
		return await activeLock.run(dir, fn);
	} finally {
		try {
			db.exec("ROLLBACK");
		} catch {}
		db.close();
	}
}
function ownersOf(data) {
	if (data === null) return {};
	const owners = data.schemaVersion === 1 ? data.owners : data;
	if (
		!owners ||
		typeof owners !== "object" ||
		Array.isArray(owners) ||
		Object.values(owners).some((v) => typeof v !== "string")
	)
		fail("Corrupt ownership registry");
	if (
		data.schemaVersion === 1 &&
		(!Number.isInteger(data.revision) || data.revision < 1 || !data.target)
	)
		fail("Corrupt registry revision");
	return owners;
}
async function registry(path) {
	const raw = await bytes(path);
	const data = raw === null ? null : parsePrivate(raw);
	ownersOf(data);
	return {
		raw,
		data,
		sha256: raw === null ? null : hash(raw),
		revision: data?.schemaVersion === 1 ? data.revision : null,
	};
}
function base(request) {
	if (
		request?.schemaVersion !== 1 ||
		!id(request.cycleId) ||
		!id(request.entornoId) ||
		!id(request.instanceId)
	)
		fail("Invalid cycle contract");
	const target = targetIdentity(request.target);
	if (!isIP(target.host)) fail("Lifecycle target requires literal IP");
	return {
		schemaVersion: 1,
		cycleId: request.cycleId,
		entornoId: request.entornoId,
		instanceId: request.instanceId,
		target,
	};
}
function same(a, b) {
	return isDeepStrictEqual(a, b);
}
function checkBase(a, b) {
	if (!same(base(a), base(b))) fail("Cycle/instance/target mismatch");
}
function machine(value) {
	if (
		!value ||
		!digest(value.machineIdHash) ||
		typeof value.machineIdMtime !== "string" ||
		!Number.isFinite(Date.parse(value.machineIdMtime))
	)
		fail("Invalid measured generation");
	return {
		machineIdHash: value.machineIdHash,
		machineIdMtime: value.machineIdMtime,
	};
}
export const TARGET_OBSERVATION_SCRIPT = `set -eu
mid=$(cat /etc/machine-id)
[ "\${#mid}" -eq 32 ]
case "$mid" in *[!a-f0-9]*) exit 42;; esac
printf 'machineIdHash='; printf '%s' "$mid" | sha256sum | cut -d ' ' -f1
printf 'machineIdMtime='; stat -c %Y /etc/machine-id
printf 'ip='; printf '%s\\n' "$SSH_CONNECTION" | awk '{print $3}'
if command -v docker >/dev/null 2>&1; then
 printf 'dockerPresent=true\\n'
 state=$(docker info --format '{{.Swarm.LocalNodeState}}')
 if [ "$state" = active ]; then services=$(docker service ls -q); elif [ "$state" = inactive ]; then services=''; else exit 43; fi
 containers=$(docker ps -aq)
 volumes=$(docker volume ls -q)
else
 printf 'dockerPresent=false\\n'
 services=''; containers=''; volumes=''
 [ ! -e /var/lib/docker ] && [ ! -L /var/lib/docker ]
 [ ! -e /var/lib/containerd ] && [ ! -L /var/lib/containerd ]
fi
printf 'services=%s\\n' "$(printf '%s' "$services" | tr '\\n' ',')"
printf 'containers=%s\\n' "$(printf '%s' "$containers" | tr '\\n' ',')"
printf 'volumes=%s\\n' "$(printf '%s' "$volumes" | tr '\\n' ',')"
if [ ! -e /opt/inventos ] && [ ! -L /opt/inventos ]; then printf 'dataDirectoriesAbsent=true\\n'; else printf 'dataDirectoriesAbsent=false\\n'; fi`;
export function parseObservation(stdout) {
	const lines = stdout.trim().split("\n");
	const keys = [
		"machineIdHash",
		"machineIdMtime",
		"ip",
		"dockerPresent",
		"services",
		"containers",
		"volumes",
		"dataDirectoriesAbsent",
	];
	if (lines.length !== keys.length) fail("Malformed observation");
	const out = {};
	for (let i = 0; i < keys.length; i++) {
		const prefix = keys[i] + "=";
		if (!lines[i].startsWith(prefix)) fail("Malformed observation");
		out[keys[i]] = lines[i].slice(prefix.length);
	}
	if (!/^\d{10}$/.test(out.machineIdMtime)) fail("Malformed machine time");
	out.machineIdMtime = new Date(
		Number(out.machineIdMtime) * 1000,
	).toISOString();
	machine(out);
	if (!isIP(out.ip)) fail("Malformed measured IP");
	for (const key of ["dockerPresent", "dataDirectoriesAbsent"]) {
		if (!["true", "false"].includes(out[key])) fail("Malformed boolean");
		out[key] = out[key] === "true";
	}
	for (const key of ["services", "containers", "volumes"]) {
		if (out[key] && !/^[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*$/.test(out[key]))
			fail("Malformed Docker list");
		out[key] = out[key] ? out[key].split(",") : [];
	}
	return out;
}
async function readTarget(target, script) {
	target = {
		...target,
		sshOptions: target.sshOptions ?? ["StrictHostKeyChecking=yes"],
	};
	const opts = { mode: "apply", readOnly: true, timeoutMs: 30000 };
	const first = await createTarget(target).exec(script, opts);
	if (first.ok && first.executed && !first.timedOut) return first;
	if (target.user !== "root") return first;
	// Contabo's fresh image exposes ubuntu/sudo until bootstrap enables root. Identity stays root:22.
	const quoted = "'" + script.replace(/'/g, "'\\''") + "'";
	return createTarget({ ...target, user: "ubuntu" }).exec(
		'sudo -n env SSH_CONNECTION="$SSH_CONNECTION" sh -c ' + quoted,
		opts,
	);
}
export async function observeMachineGeneration(target) {
	const r = await readTarget(
		target,
		`set -eu; mid=$(cat /etc/machine-id); [ "\${#mid}" -eq 32 ]; case "$mid" in *[!a-f0-9]*) exit 42;; esac; printf '%s' "$mid" | sha256sum | cut -d ' ' -f1; stat -c %Y /etc/machine-id`,
	);
	if (!r.executed || !r.ok || r.timedOut) fail("Machine generation unknown");
	const lines = r.stdout.trim().split("\n");
	if (lines.length !== 2 || !/^\d{10}$/.test(lines[1]))
		fail("Malformed machine generation");
	return machine({
		machineIdHash: lines[0],
		machineIdMtime: new Date(Number(lines[1]) * 1000).toISOString(),
	});
}
async function observe(target) {
	const r = await readTarget(target, TARGET_OBSERVATION_SCRIPT);
	if (!r.executed || !r.ok || r.timedOut)
		fail("Target observation failed; disk state unknown");
	return parseObservation(r.stdout);
}
async function measured(target, options) {
	const o = await (options.observe ?? observe)(target);
	machine(o);
	if (o.ip !== target.host) fail("Measured IP mismatch");
	for (const k of ["services", "containers", "volumes"])
		if (!Array.isArray(o[k]) || o[k].some((v) => typeof v !== "string"))
			fail("Malformed disk observation");
	if (
		typeof o.dockerPresent !== "boolean" ||
		typeof o.dataDirectoriesAbsent !== "boolean"
	)
		fail("Malformed disk observation");
	return o;
}
/** Only the authenticated worker's durable reinstall stamp enables lifecycle TOFU.
 * Snapshot uses the previous strict host policy; this path never modifies global known_hosts.
 */
async function lifecycleMeasured(b, authorization, options) {
	if (
		!authorization ||
		typeof authorization.reinstalledAt !== "string" ||
		!Number.isFinite(Date.parse(authorization.reinstalledAt))
	)
		fail("Missing reinstall authorization");
	checkBase(b, authorization);
	const cycle = join(
		dirname(stackOwnershipRegistryPath(b.target, options.home)),
		"cycles",
		b.cycleId,
	);
	await safeDirectory(cycle);
	const snapshot = await json(join(cycle, "snapshot.json"));
	if (!snapshot) fail("Authorization requires private snapshot");
	checkBase(b, snapshot);
	const approved = { ...b, reinstalledAt: authorization.reinstalledAt };
	const authPath = join(cycle, "authorization.json");
	const prior = await json(authPath);
	if (prior && !same(prior, approved)) fail("Reinstall authorization changed");
	if (!prior) await atomic(authPath, approved);
	// Unit observers replace the transport only; CLI cannot supply this option.
	if (options.observe) return measured(b.target, options);
	const knownHosts = join(cycle, "known_hosts");
	const sealPath = join(cycle, "ssh-generation.json");
	const seal = await json(sealPath);
	let original = await bytes(knownHosts);
	if (
		seal &&
		(!original ||
			hash(original) !== seal.knownHostsHash ||
			!same(seal.authorization, approved))
	)
		fail("Private host-key evidence changed or missing");
	if (original?.length) {
		try {
			await promisify(execFile)("ssh-keygen", ["-l", "-f", knownHosts], {
				timeout: 10000,
				maxBuffer: 65536,
			});
		} catch {
			fail("Corrupt private known_hosts");
		}
	}
	if (!original) {
		const fd = await open(
			knownHosts,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		await fd.close();
	}
	const quoted = '"' + knownHosts.replace(/[\\"]/g, "\\$&") + '"';
	const target = {
		...b.target,
		sshOptions: [
			"StrictHostKeyChecking=accept-new",
			"UserKnownHostsFile=" + quoted,
			"GlobalKnownHostsFile=/dev/null",
			"UpdateHostKeys=no",
		],
	};
	let observation;
	try {
		observation = await measured(target, options);
	} catch (error) {
		// An unsealed attempt may have reached the pre-reimage host while the provider was rebooting.
		// It has not attested a new generation. A sealed key is never reset on failure or replay.
		if (!seal) {
			await bytes(knownHosts);
			await unlink(knownHosts);
			await syncDirectory(cycle);
		}
		throw error;
	}
	if (
		!seal &&
		(observation.machineIdHash === snapshot.previousMachine.machineIdHash ||
			Date.parse(observation.machineIdMtime) <
				Date.parse(approved.reinstalledAt))
	) {
		await bytes(knownHosts);
		await unlink(knownHosts);
		await syncDirectory(cycle);
		return observation;
	}
	const after = await bytes(knownHosts);
	if (!after?.length) fail("SSH did not persist private host-key evidence");
	if (seal) {
		if (
			hash(after) !== seal.knownHostsHash ||
			!same(machine(observation), seal.generation)
		)
			fail("SSH generation changed within cycle");
	} else {
		await atomic(sealPath, {
			schemaVersion: 1,
			authorization: approved,
			generation: machine(observation),
			knownHostsHash: hash(after),
		});
	}
	return observation;
}
export async function inspectTarget(request, options = {}) {
	const b = base(request);
	return withTargetLock(
		b.target,
		() => lifecycleMeasured(b, request.authorization, options),
		options.home,
	);
}
export async function snapshotTarget(request, options = {}) {
	const b = base(request);
	return withTargetLock(
		b.target,
		async () => {
			const path = stackOwnershipRegistryPath(b.target, options.home);
			const cycle = join(dirname(path), "cycles", b.cycleId);
			await safeDirectory(cycle);
			const stored = await json(join(cycle, "snapshot.json"));
			if (stored) {
				checkBase(b, stored);
				return stored;
			}
			const r = await registry(path);
			if (
				r.data?.schemaVersion === 1 &&
				(!same(r.data.target, b.target) ||
					(r.data.instanceId !== null && r.data.instanceId !== b.instanceId))
			)
				fail("Registry instance/target mismatch");
			const previousMachine = machine(await measured(b.target, options));
			const snapshot = {
				...b,
				registry: { sha256: r.sha256, revision: r.revision },
				previousMachine,
			};
			await atomic(join(cycle, "snapshot.json"), snapshot);
			return snapshot;
		},
		options.home,
	);
}
export async function reconcileTarget(request, options = {}) {
	const b = base(request);
	checkBase(b, request.snapshot);
	checkBase(b, request.receipt);
	return withTargetLock(
		b.target,
		async () => {
			const path = stackOwnershipRegistryPath(b.target, options.home);
			const cycle = join(dirname(path), "cycles", b.cycleId);
			await safeDirectory(cycle);
			const stored = await json(join(cycle, "snapshot.json"));
			if (!stored || !same(stored, request.snapshot))
				fail("Snapshot not recorded before cycle");
			const desired = machine(request.receipt);
			if (desired.machineIdHash === stored.previousMachine.machineIdHash)
				fail("Generation unchanged");
			if (
				!Number.isFinite(Date.parse(request.receipt.reinstalledAt)) ||
				Date.parse(desired.machineIdMtime) <
					Date.parse(request.receipt.reinstalledAt)
			)
				fail("Generation predates cycle anchor");
			const observation = await lifecycleMeasured(b, request.receipt, options);
			if (!same(machine(observation), desired))
				fail("Measured generation mismatch");
			if (
				observation.services.length ||
				observation.containers.length ||
				observation.volumes.length ||
				!observation.dataDirectoriesAbsent
			)
				fail("Disk not empty");
			const current = await registry(path);
			const archive = join(cycle, "archive.json");
			const archived = await bytes(archive);
			const sourceHash = stored.registry.sha256;
			const result = {
				...b,
				...desired,
				sourceHash,
				archiveHash: sourceHash,
				revision: (stored.registry.revision ?? 0) + 1,
			};
			const receiptPath = join(cycle, "receipt.json");
			const done = await json(receiptPath);
			if (done) {
				if (
					!same(done, result) ||
					current.sha256 !== null ||
					(sourceHash !== null &&
						(archived === null || hash(archived) !== sourceHash))
				)
					fail("Replay has new ownership or altered archive");
				return done;
			}
			const journalPath = join(cycle, "journal.json");
			const journal = await json(journalPath);
			if (journal && !same(journal, result)) fail("Journal mismatch");
			if (current.sha256 !== sourceHash) {
				if (
					!journal ||
					current.sha256 !== null ||
					sourceHash === null ||
					archived === null ||
					hash(archived) !== sourceHash
				)
					fail("CAS registry changed");
			} else {
				if (archived !== null) fail("Archive already exists");
				await atomic(journalPath, result);
				if (current.raw !== null) {
					await rename(path, archive);
					await syncDirectory(dirname(path));
					await syncDirectory(cycle);
					await options.afterArchive?.();
				}
			}
			await atomic(receiptPath, result);
			// The apply that comes after this cycle must be bound to THIS generation. Archiving the
			// registry leaves `stacks.json` absent, and an absent registry used to mean "no generation
			// to compare" — so apply accepted whatever it observed. The marker is what closes that.
			await atomic(reconciledGenerationPath(b.target, options.home), {
				schemaVersion: 1,
				target: targetIdentity(b.target),
				cycleId: b.cycleId,
				instanceId: b.instanceId,
				machineIdHash: desired.machineIdHash,
				machineIdMtime: desired.machineIdMtime,
			});
			return result;
		},
		options.home,
	);
}
// Called only inside apply's full-operation lock. Collisions are checked before secrets/render/deploy.
export async function assertStackOwnership(
	stacks,
	project,
	target,
	options = {},
) {
	if (
		!id(project) ||
		(options.orgId !== undefined && !id(options.orgId)) ||
		(options.workId !== undefined && !id(options.workId)) ||
		(options.instanceId !== undefined && !id(options.instanceId))
	)
		fail("Invalid owner identity");
	const path = stackOwnershipRegistryPath(target, options.home);
	if (activeLock.getStore() !== dirname(path))
		fail("Ownership writer requires target lock");
	const r = await registry(path);
	const owners = ownersOf(r.data);
	if (r.data?.schemaVersion === 1) {
		if (!same(r.data.target, targetIdentity(target)))
			fail("Registry target mismatch");
		if ((r.data.orgId ?? null) !== (options.orgId ?? null))
			fail("Organization ownership collision");
		if (r.data.instanceId && r.data.instanceId !== options.instanceId)
			fail("Instance ownership collision");
		if (r.data.generation && !same(r.data.generation, options.generation))
			fail("Machine generation changed; canonical reconciliation required");
	} else if (r.data !== null && options.orgId)
		fail("Legacy ownership requires reviewed migration or canonical cleaning");
	if (r.data === null) {
		// An ABSENT registry is the normal state right after a cleaning cycle: reconciliation archives
		// `stacks.json`. Until this check existed, that state skipped the generation comparison
		// entirely and apply accepted any generation it happened to observe — so a disk reimaged
		// AGAIN between the receipt and the install (or a target repointed at another machine) went
		// through unnoticed, and the tenant's stack landed on it.
		//
		// The marker is only present when a cycle actually ran. Its absence means "never
		// reconciled" — a freshly bought VPS — and that path stays as it was: this must not block the
		// ordinary first install.
		const marker = await json(reconciledGenerationPath(target, options.home));
		if (marker) {
			if (!same(marker.target, targetIdentity(target)))
				fail("Reconciled generation belongs to another target");
			if (!options.generation)
				fail("Reconciled target requires the authorized generation");
			if (!same(machine(marker), machine(options.generation)))
				fail("Machine generation changed after reconciliation; canonical reconciliation required");
		} else if (options.generation) {
			// NO LOCAL STATE AT ALL — and local silence says nothing about the remote machine.
			//
			// The marker lives under the operator's HOME. A second operator (another laptop, another
			// container, a rebuilt CI runner) has neither registry nor marker for a target someone
			// else already owns, and until this branch existed that read as a clean slate: apply
			// wrote fresh ownership over a running installation, silently.
			//
			// So the machine is asked instead of assumed. An empty disk is a genuinely new target and
			// the ordinary first install proceeds untouched; anything running on it means this
			// operator has no record of an installation that exists, and that is not something to
			// resolve by overwriting. The refusal names the recovery: reconcile the target, or run
			// from the operator whose state owns it.
			//
			// Only for remote targets: `apply` passes no generation for a local one, and there is no
			// disk of someone else's to walk into.
			const remote = await measured(target, options);
			if (
				remote.services.length ||
				remote.containers.length ||
				remote.volumes.length ||
				!remote.dataDirectoriesAbsent
			)
				fail(
					"Target already carries an installation this operator has no record of; reconcile the target or apply from the operator that owns its state",
				);
		}
	}
	for (const s of stacks)
		if (owners[s] !== undefined && owners[s] !== project)
			fail("Stack belongs to another project");
	for (const s of stacks) owners[s] = project;
	const generation = options.generation ?? r.data?.generation ?? null;
	await atomic(path, {
		schemaVersion: 1,
		target: targetIdentity(target),
		instanceId: options.instanceId ?? null,
		orgId: options.orgId ?? null,
		workId: options.workId ?? null,
		generation,
		revision: (r.revision ?? 0) + 1,
		owners,
	});
}
