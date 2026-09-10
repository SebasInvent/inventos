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
	const dir = await home(t);
	await gate(dir, C);
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
 * KNOWN LIMIT, measured on purpose: local absence proves nothing about the remote machine.
 *
 * The marker lives under the operator's HOME. A second operator — another laptop, another
 * container, a rebuilt CI runner — has no marker and no registry for the same target, and the gate
 * reads that as "never reconciled" and lets the install through.
 *
 * This is NOT a hole the marker introduced: `assertStackOwnership` already treated an absent
 * registry as a clean slate long before it existed, and that is what makes an ordinary first
 * install possible at all. What the marker changed is that the state now MATTERS, so the gap is
 * worth naming instead of leaving implied.
 *
 * Closing it needs something this file cannot fake: asking the MACHINE whether it is empty before
 * trusting local silence. `observeMachineGeneration` — the only remote call apply makes before the
 * gate — returns the machine id, not whether services, containers or volumes are running. Adding
 * that observation means another remote round trip on every real apply, and it cannot be honestly
 * verified without a VPS. So it is written down with its owner rather than half-implemented:
 *
 *   owner: claude-journey (InventOS #3)
 *   closes when: apply observes remote emptiness before writing ownership on a target with no local
 *                state, and refuses with a recoverable reason when the disk is not empty
 *   until then: an operator installing onto a target another operator owns is caught by the deploy
 *               procedure, not by this gate
 *
 * The test asserts TODAY'S behaviour so the day someone closes it, this goes red and gets rewritten
 * instead of quietly staying as a false reassurance.
 */
test("KNOWN LIMIT: another operator's HOME sees no marker and is not stopped by it", async (t) => {
	const dirA = await home(t);
	await cycle(dirA);
	// Same target, same everything — a different operator's state directory.
	const dirB = await home(t);
	await gate(dirB, C); // does NOT throw, and that is the limit being recorded
	// And the control that keeps this honest: in the operator that DID run the cycle, C is rejected.
	await assert.rejects(() => gate(dirA, C), /generation changed after reconciliation/i);
});
