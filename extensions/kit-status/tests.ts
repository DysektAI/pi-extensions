import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runKitStatusScript, runWith } from "./runner.ts";

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
		child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() {} });
		child.kill = () => { killed++; queueMicrotask(() => child.emit("close", null)); };
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

test("probe timeout permits fallback; script timeout waits for close and does not retry", async () => {
	const probe = mockProcesses([{ timeout: true }, { out: ["kit-python-ready"] }, { out: ["drift"] }]);
	assert.equal(await runKitStatusScript(script, candidates, probe.spawnProcess, 5), "drift");
	assert.equal(probe.killed(), 1);
	const scriptTimeout = mockProcesses([{ out: ["kit-python-ready"] }, { timeout: true }]);
	assert.equal(await runKitStatusScript(script, candidates, scriptTimeout.spawnProcess, 5), "");
	assert.equal(scriptTimeout.killed(), 1);
	assert.equal(scriptTimeout.calls.length, 2);
});


test("timeout waits for close, escalates SIGKILL, and cleans stdout listeners", async () => {
	const child = new EventEmitter() as any;
	let destroyed = false;
	child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() { destroyed = true; } });
	const signals: string[] = [];
	let closed = false;
	child.kill = (signal: string) => {
		signals.push(signal);
		if (signal === "SIGKILL") setTimeout(() => { closed = true; child.emit("close", null); }, 5);
		return true;
	};
	child.unref = () => assert.fail("closed process does not require unref");
	const result = await runWith(["python"], [script], (() => child) as typeof spawn, 5, 10);
	assert.equal(result, "");
	assert.equal(closed, true);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(destroyed, true);
	assert.equal(child.stdout.listenerCount("data"), 0);
	assert.equal(child.listenerCount("close"), 0);
});

test("bounded shutdown releases handles when no close event arrives", async () => {
	const child = new EventEmitter() as any;
	let destroyed = false;
	let unreferenced = false;
	child.stdout = Object.assign(new EventEmitter(), { setEncoding() {}, destroy() { destroyed = true; } });
	const signals: string[] = [];
	child.kill = (signal: string) => { signals.push(signal); return false; };
	child.unref = () => { unreferenced = true; };
	assert.equal(await runWith(["python"], [script], (() => child) as typeof spawn, 5, 5), "");
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(unreferenced, true);
	assert.equal(destroyed, true);
	assert.equal(child.stdout.listenerCount("data"), 0);
});

test("actual SIGTERM-resistant child is reaped before timeout resolves", { skip: process.platform === "win32" }, async () => {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    let closed = false;
    let signal: NodeJS.Signals | null = null;
    child.on("close", (_code, received) => { closed = true; signal = received; });
    try {
        await new Promise<void>((resolve, reject) => {
            let output = "";
            const timer = setTimeout(() => finish(new Error("child did not become ready")), 10_000);
            const onData = (chunk: Buffer) => {
                output += String(chunk);
                if (output.includes("ready")) finish();
            };
            const onError = (error: Error) => finish(error);
            const onClose = () => finish(new Error("child exited before readiness"));
            const finish = (error?: Error) => {
                clearTimeout(timer);
                child.stdout?.off("data", onData);
                child.off("error", onError);
                child.off("close", onClose);
                if (error) reject(error); else resolve();
            };
            child.stdout?.on("data", onData);
            child.on("error", onError);
            child.on("close", onClose);
        });
        const spawnProcess = (() => child) as typeof spawn;
        const result = await runWith([process.execPath], [], spawnProcess, 5, 30);
        assert.equal(result, "");
        assert.equal(closed, true);
        assert.equal(signal, "SIGKILL");
        assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" });
    } finally { if (!closed) child.kill("SIGKILL"); }
});
