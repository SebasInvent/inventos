/**
 * APPLY MUST BE BOUND TO THE GENERATION THE CYCLE ACCREDITED.
 *
 * Reproduced by review on 10-Sep-2026, before this branch was merged. `reconcileTarget` archives
 * `stacks.json`, so right after a cleaning cycle the registry is ABSENT — and an absent registry
 * skipped the generation comparison in `assertStackOwnership` entirely. Apply then accepted whatever
 * generation it observed, with nothing tying it to the receipt.
 *
 * What that lets through: the disk is reimaged AGAIN between the receipt and the install, or the
 * target is repointed at another machine, and the tenant's stack lands on it. Nothing fails, nothing
 * logs — the cycle said "clean, generation B" and apply installs onto C.
 *
 * Comparing the three SSH policies does NOT close this: those govern host keys, not which machine
 * the ownership record is written for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertStackOwnership,
	reconciledGenerationPath,
	reconcileTarget,
	snapshotTarget,
	withTargetLock,
} from "../src/engine/target-registry.ts";

const target = { host: "203.0.113.10", user: "root", port: 22 };
const A = { machineIdHash: "a".repeat(64), machineIdMtime: "2026-09-01T00:00:00.000Z" };
const B = { machineIdHash: "b".repeat(64), machineIdMtime: "2026-09-08T00:00:01.000Z" };
const C = { machineIdHash: "c".repeat(64), machineIdMtime: "2026-09-08T00:05:01.000Z" };
const observed = (g) => ({
	...g,
	ip: target.host,
	services: [],
	containers: [],
	volumes: [],
	dockerPresent: false,
	dataDirectoriesAbsent: true,
});

async function home(t) {
	const dir = await mkdtemp(join(await realpath(tmpdir()), "generation-after-reconcile-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

const request = {
	schemaVersion: 1,
	cycleId: "cycle-1",
	entornoId: "org-a",
	instanceId: "instance-1",
	target,
};

/** Runs a full cycle: snapshot of A, then reconcile onto B. Returns the receipt. */
async function cycle(dir) {
	const snapshot = await snapshotTarget(request, { home: dir, observe: async () => observed(A) });
	return reconcileTarget(
		{
			...request,
			snapshot,
			receipt: { ...request, ...B, reinstalledAt: "2026-09-08T00:00:00.000Z" },
		},
		{ home: dir, observe: async () => observed(B) },
	);
}

const gate = (dir, generation, options = {}) =>
	withTargetLock(
		target,
		() =>
			assertStackOwnership(["chatbotx"], "project-a", target, {
				home: dir,
				orgId: "org-a",
				workId: "install-job",
				instanceId: "instance-1",
				generation,
				...options,
			}),
		dir,
	);

const empty = {
	services: [],
	containers: [],
	volumes: [],
	dockerPresent: false,
	dataDirectoriesAbsent: true,
};
const observing = (dir, generation, remote) =>
	withTargetLock(
		target,
		() =>
			assertStackOwnership(["chatbotx"], "project-a", target, {
				home: dir,
				orgId: "org-a",
				workId: "install-job",
				instanceId: "instance-1",
				generation,
				observe: async () => ({ ...generation, ip: target.host, ...remote }),
			}),
		dir,
	);

test("the generation the cycle accredited is accepted", async (t) => {
	// Control. Without it the rejection below could pass with a gate that rejects everything.
	const dir = await home(t);
	const receipt = await cycle(dir);
	assert.equal(receipt.machineIdHash, B.machineIdHash);
	await gate(dir, B);
});

test("a DIFFERENT generation after reconciling is rejected", async (t) => {
	const dir = await home(t);
	await cycle(dir);
	await assert.rejects(() => gate(dir, C), /generation changed after reconciliation/i);
});

test("after reconciling, apply cannot omit the generation", async (t) => {
	// Omitting it used to be equivalent to "no generation to compare", which is how the hole was
	// reachable in the first place. An absent field is not an accredited match.
	const dir = await home(t);
	await cycle(dir);
	await assert.rejects(() => gate(dir, undefined), /requires the authorized generation/i);
});

test("a target that was NEVER reconciled still installs normally", async (t) => {
	// The other half of the cut, and the one that keeps this from breaking production: a freshly
	// bought VPS has no marker, and the ordinary first install must not be blocked by a cycle that
	// never happened.
	//
	// It goes through `observing` and not `gate` since the gap was closed: with no local state at
	// all, the machine is now asked whether it is empty, so this case has to say what the machine
	// answers. Left on `gate` it reaches for a real SSH probe against a documentation IP and hangs
	// twenty seconds before failing — the test would be measuring the network, not the rule.
	const dir = await home(t);
	await observing(dir, C, empty);
});

test("the second apply keeps comparing, now through the registry it just wrote", async (t) => {
	// Once apply writes ownership the registry is present again, so the existing schemaVersion 1
	// branch takes over. This asserts the two checks meet instead of leaving a gap between them.
	const dir = await home(t);
	await cycle(dir);
	await gate(dir, B);
	await assert.rejects(() => gate(dir, C), /generation changed/i);
});

test("a marker written for another target does not accredit this one", async (t) => {
	// The marker lives in a directory derived from the target's own hash, so it cannot belong to
	// another one by the normal path — this is defence in depth, the same reason the registry already
	// checks `r.data.target`. Without the check a hand-placed or misfiled marker would accredit a
	// generation for a machine nobody reconciled, and it would do it silently.
	const dir = await home(t);
	await cycle(dir);
	await writeFile(
		reconciledGenerationPath(target, dir),
		JSON.stringify({
			schemaVersion: 1,
			target: { host: "198.51.100.7", user: "root", port: 22 },
			cycleId: "cycle-1",
			instanceId: "instance-1",
			...B,
		}) + "\n",
	);
	await assert.rejects(() => gate(dir, B), /belongs to another target/i);
});

/**
 * NO LOCAL STATE IS NOT AN EMPTY MACHINE — the operator/HOME gap, now closed.
 *
 * Raised in review: the marker lives under the operator's HOME, so a second operator (another
 * laptop, another container, a rebuilt CI runner) has neither registry nor marker for a target
 * someone else already owns. That used to read as a clean slate, and apply wrote fresh ownership
 * over a running installation without a word.
 *
 * Writing a test that asserted the failure was NOT closing it, and saying so was not enough either.
 * The gate now asks the machine instead of assuming: an empty disk is a genuinely new target and the
 * ordinary first install proceeds; anything running on it is an installation this operator has no
 * record of, and the refusal names the recovery.
 *
 * ## What is verified here and what is not
 *
 * The observation is doubled, so what these cases accredit is the DECISION: which observations pass,
 * which refuse, and that a brand-new target is not blocked. What they do NOT accredit is the real
 * remote probe — that `TARGET_OBSERVATION_SCRIPT` reports services, containers and volumes correctly
 * over SSH against a live VPS, and that the extra round trip it adds to every real apply is
 * acceptable. That validation stays pending and needs a VPS; it is not something a double can stand
 * in for.
 */

test("another operator does NOT walk into a target that is already running something", async (t) => {
	const dirA = await home(t);
	await cycle(dirA);
	// Same target, a different operator's state directory — and a machine with work on it.
	const dirB = await home(t);
	await assert.rejects(
		() => observing(dirB, C, { ...empty, services: ["chatbotx_web"], dockerPresent: true }),
		/no record of/i,
	);
});

test("...and a genuinely empty target still installs normally", async (t) => {
	// The half that keeps this from breaking production: a freshly bought VPS has no local state and
	// nothing running, and the ordinary first install must not be blocked by a cycle that never
	// happened. Without this case, closing the gap takes down every new customer.
	const dirB = await home(t);
	await observing(dirB, C, empty);
});

test("a volume left behind is enough to refuse: absence of services is not emptiness", async (t) => {
	// Each signal on its own, with the others in a value that passes (rule 11). A stopped stack
	// leaves volumes with the previous tenant's data, and overwriting those is the expensive half.
	const dirB = await home(t);
	await assert.rejects(
		() => observing(dirB, C, { ...empty, volumes: ["chatbotx_pgdata"] }),
		/no record of/i,
	);
	const dirC = await home(t);
	await assert.rejects(
		() => observing(dirC, C, { ...empty, containers: ["chatbotx_worker"] }),
		/no record of/i,
	);
	const dirD = await home(t);
	await assert.rejects(
		() => observing(dirD, C, { ...empty, dataDirectoriesAbsent: false }),
		/no record of/i,
	);
});

test("the operator that DID run the cycle still compares generations, not emptiness", async (t) => {
	// The marker keeps priority: where there IS local state, the question is still "is this the
	// generation the cycle accredited", and an empty disk does not excuse a different one.
	const dirA = await home(t);
	await cycle(dirA);
	await assert.rejects(
		() => observing(dirA, C, empty),
		/generation changed after reconciliation/i,
	);
	await observing(dirA, B, empty);
});
