import { spawn } from "node:child_process";

/** Output of kit_status --notice ("" on failure or timeout), or undefined when the interpreter could not start. */
function runWith(command: readonly [string, ...string[]], args: string[], spawnProcess: typeof spawn, timeoutMs: number): Promise<string | undefined> {
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
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		timer = setTimeout(() => {
			child.kill();
			finish("");
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
		});
		// Spawn failure (e.g. ENOENT): undefined lets the caller try the next interpreter.
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? out.trim() : ""));
	});
}


/** Probe Python separately so launcher failures cannot be confused with script failures. */
export async function runKitStatusScript(
	script: string,
	candidates: ReadonlyArray<readonly [string, ...string[]]>,
	spawnProcess: typeof spawn = spawn,
	timeoutMs = 10_000,
): Promise<string> {
	for (const command of candidates) {
		const probe = await runWith(command, ["-c", "import sys; print('kit-python-ready' if sys.version_info[0] == 3 else '')"], spawnProcess, timeoutMs);
		if (probe !== "kit-python-ready") continue;
		// Once an interpreter works, execute the notice script only once. A script
		// failure may already have consumed its pending notice and must not retry.
		return (await runWith(command, [script, "--notice"], spawnProcess, timeoutMs)) ?? "";
	}
	return "";
}
