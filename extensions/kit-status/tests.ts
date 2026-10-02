import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runKitStatusScript } from "./runner.ts";

const candidates = [["py", "-3"], ["python"]] as const;
const script = "C:\\kit path\\shared\\scripts\\kit_status.py";
interface Outcome { code?: number; out?: string[]; error?: boolean; throws?: boolean; timeout?: boolean }
function mockProcesses(outcomes: Outcome[]) {
	const calls: Array<{ file: string; args: string[] }> = [];
	let killed = 0;
	const spawnProcess = ((file: string, args: string[]) => {
		calls.push({ file, args });
		const outcome = outcomes.shift();
		assert.ok(outcome, "unexpected extra interpreter/script launch");
		if (outcome.throws) throw new Error("cannot spawn");
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding: () => void }; kill: () => void };
		child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
		child.kill = () => { killed++; };
		queueMicrotask(() => {
			if (outcome.timeout) return;
			if (outcome.error) { child.emit("error", new Error("ENOENT")); child.emit("close", -1); return; }
			for (const chunk of outcome.out ?? []) child.stdout.emit("data", chunk);
			child.emit("close", outcome.code ?? 0);
		});
		return child;
	}) as typeof spawn;
	return { spawnProcess, calls, killed: () => killed };
}

test("Windows launcher selection failure falls back to python before executing script", async () => {
	const mock = mockProcesses([{ code: 103 }, { out: ["kit-python-ready\n"] }, { out: [" pending ", "notice \n"] }]);
	assert.equal(await runKitStatusScript(script, candidates, mock.spawnProcess), "pending notice");
	assert.deepEqual(mock.calls.map((call) => call.file), ["py", "python", "python"]);
	assert.deepEqual(mock.calls[0].args.slice(0, 2), ["-3", "-c"]);
	assert.deepEqual(mock.calls[2].args, [script, "--notice"]);
	assert.ok(mock.calls.slice(0, 2).every((call) => !call.args.includes(script)));
});

test("script failure does not retry even with the same exit code as a launcher failure", async () => {
	const mock = mockProcesses([{ out: ["kit-python-ready\n"] }, { code: 103, out: ["discard partial output"] }]);
	assert.equal(await runKitStatusScript(script, candidates, mock.spawnProcess), "");
	assert.equal(mock.calls.length, 2);
	assert.deepEqual(mock.calls[1], { file: "py", args: ["-3", script, "--notice"] });
});

test("missing interpreter and synchronous spawn failure permit fallback", async () => {
	for (const failure of [{ error: true }, { throws: true }]) {
		const mock = mockProcesses([failure, { out: ["kit-python-ready"] }, { out: ["drift"] }]);
		assert.equal(await runKitStatusScript(script, candidates, mock.spawnProcess), "drift");
		assert.equal(mock.calls.length, 3);
	}
});

test("Python 2 or Store stub does not qualify as an interpreter", async () => {
	const mock = mockProcesses([{ out: ["\n"] }, { code: 1 }]);
	assert.equal(await runKitStatusScript(script, candidates, mock.spawnProcess), "");
	assert.ok(mock.calls.every((call) => call.args.includes("-c")));
});

test("probe timeout permits fallback; script timeout kills once and does not retry", async () => {
	const probe = mockProcesses([{ timeout: true }, { out: ["kit-python-ready"] }, { out: ["drift"] }]);
	assert.equal(await runKitStatusScript(script, candidates, probe.spawnProcess, 5), "drift");
	assert.equal(probe.killed(), 1);
	const scriptTimeout = mockProcesses([{ out: ["kit-python-ready"] }, { timeout: true }]);
	assert.equal(await runKitStatusScript(script, candidates, scriptTimeout.spawnProcess, 5), "");
	assert.equal(scriptTimeout.killed(), 1);
	assert.equal(scriptTimeout.calls.length, 2);
});
