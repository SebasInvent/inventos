import {
	snapshotTarget,
	inspectTarget,
	reconcileTarget,
} from "./target-registry.ts";
export const REGISTRY_COMMANDS = [
	"snapshot-target",
	"inspect-target",
	"reconcile-target",
];
/** stdin carries the durable worker contract; no arbitrary paths, shell or force flags. */
export async function runRegistryCommand(command, argv, input = process.stdin) {
	if (
		!REGISTRY_COMMANDS.includes(command) ||
		argv.some((arg) => arg !== "--json")
	)
		throw Error(
			"Lifecycle commands accept only --json; contract goes through stdin",
		);
	let raw = "";
	for await (const chunk of input) {
		raw += chunk;
		if (Buffer.byteLength(raw) > 65536)
			throw Error("Lifecycle contract too large");
	}
	let request;
	try {
		request = JSON.parse(raw);
	} catch {
		throw Error("Invalid lifecycle JSON");
	}
	const operation = {
		"snapshot-target": snapshotTarget,
		"inspect-target": inspectTarget,
		"reconcile-target": reconcileTarget,
	}[command];
	const key = {
		"snapshot-target": "snapshot",
		"inspect-target": "observation",
		"reconcile-target": "reconciliation",
	}[command];
	return { ok: true, [key]: await operation(request) };
}
