import { spawn } from "node:child_process";

/** Wait for process shutdown before releasing a timed-out interpreter or script. */
export function runWith(
	command: readonly [string, ...string[]], args: string[], spawnProcess: typeof spawn,
	timeoutMs: number, killGraceMs = 1_000,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		const [file, ...prefix] = command;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnProcess(file, [...prefix, ...args], { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return resolve(undefined);
		}
		let out = "";
		let settled = false;
		let timedOut = false;
		const timers: Array<ReturnType<typeof setTimeout>> = [];
		const onData = (chunk: string) => { if (!timedOut) out += chunk; };
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			for (const timer of timers) clearTimeout(timer);
			child.stdout?.off("data", onData);
			child.stdout?.destroy();
			child.off("close", onClose);
			child.off("error", onError);
			resolve(value);
		};
		const onClose = (code: number | null) => finish(timedOut ? "" : code === 0 ? out.trim() : "");
		const onError = () => {
			// Kill errors do not prove the process exited; retain the shutdown deadline.
			if (!timedOut) finish(undefined);
		};
		timers.push(setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			if (settled) return;
			timers.push(setTimeout(() => {
				child.kill("SIGKILL");
				if (settled) return;
				timers.push(setTimeout(() => {
					// If the OS cannot reap the child, release all event-loop handles
					// after the bounded kill grace rather than keeping Pi alive.
					child.unref();
					finish("");
				}, killGraceMs));
			}, killGraceMs));
		}, timeoutMs));
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", onData);
		child.on("error", onError);
		child.on("close", onClose);
	});
}

/** Probe Python separately so launcher failures cannot be confused with script failures. */
export async function runKitStatusScript(
	script: string,
	candidates: ReadonlyArray<readonly [string, ...string[]]>,
	spawnProcess: typeof spawn = spawn,
	timeoutMs = 10_000,
	killGraceMs = 1_000,
): Promise<string> {
	for (const command of candidates) {
		const probe = await runWith(command, ["-c", "import sys; print('kit-python-ready' if sys.version_info[0] == 3 else '')"], spawnProcess, timeoutMs, killGraceMs);
		if (probe !== "kit-python-ready") continue;
		// Once an interpreter works, execute the notice script only once. A script
		// failure may already have consumed its pending notice and must not retry.
		return (await runWith(command, [script, "--notice"], spawnProcess, timeoutMs, killGraceMs)) ?? "";
	}
	return "";
}
