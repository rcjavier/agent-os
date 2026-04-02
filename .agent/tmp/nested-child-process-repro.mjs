import { resolve } from "node:path";
import { AgentOs } from "../../packages/core/dist/agent-os.js";

const MODULE_ACCESS_CWD = resolve(import.meta.dirname, "../../packages/core");

const vm = await AgentOs.create({
	moduleAccessCwd: MODULE_ACCESS_CWD,
});

try {
	await vm.writeFile(
		"/tmp/child.mjs",
		[
			"process.stderr.write('child_boot\\\\n');",
			"process.stdin.setEncoding('utf8');",
			"let buffer = '';",
			"process.stdin.on('data', (chunk) => {",
			"  process.stderr.write('child_data:' + JSON.stringify(chunk) + '\\\\n');",
			"  buffer += chunk;",
			"  while (true) {",
			"    const idx = buffer.indexOf('\\\\n');",
			"    if (idx === -1) break;",
			"    const line = buffer.slice(0, idx);",
			"    buffer = buffer.slice(idx + 1);",
			"    if (!line) continue;",
			"    process.stdout.write(JSON.stringify({ seen: line }) + '\\\\n');",
			"  }",
			"});",
			"process.stdin.on('end', () => {",
			"  process.stderr.write('child_end\\\\n');",
			"  process.exit(0);",
			"});",
		].join("\n"),
	);

	await vm.writeFile(
		"/tmp/parent.mjs",
		[
			'import { spawn } from "node:child_process";',
			'const child = spawn("node", ["/tmp/child.mjs"], { stdio: ["pipe", "pipe", "pipe"] });',
			'console.log("parent_spawned pid=" + child.pid);',
			'child.on("spawn", () => console.log("parent_child_spawn_event"));',
			'child.on("error", (error) => console.log("parent_child_error:" + error.message));',
			'child.on("exit", (code, signal) => console.log("parent_child_exit:" + code + ":" + signal));',
			'child.stdout.setEncoding("utf8");',
			'child.stderr.setEncoding("utf8");',
			'child.stdout.on("data", (chunk) => console.log("parent_stdout:" + JSON.stringify(chunk)));',
			'child.stderr.on("data", (chunk) => console.log("parent_stderr:" + JSON.stringify(chunk)));',
			'child.stdin.write(JSON.stringify({ hello: "world" }) + "\\n");',
			'setTimeout(() => child.stdin.end(), 100);',
			'setTimeout(() => console.log("parent_done_waiting"), 1000);',
		].join("\n"),
	);

	let stdout = "";
	let stderr = "";

	const { pid } = vm.spawn("node", ["/tmp/parent.mjs"], {
		env: { HOME: "/home/user" },
		onStdout: (data) => {
			stdout += new TextDecoder().decode(data);
		},
		onStderr: (data) => {
			stderr += new TextDecoder().decode(data);
		},
	});

	await new Promise((resolve) => setTimeout(resolve, 3_000));

	const listProcesses =
		typeof vm.listProcesses === "function" ? vm.listProcesses() : undefined;
	const processTree =
		typeof vm.processTree === "function" ? vm.processTree() : undefined;

	vm.killProcess(pid);
	const exitCode = await vm.waitProcess(pid);

	console.log(
		JSON.stringify(
			{ exitCode, stdout, stderr, listProcesses, processTree },
			null,
			2,
		),
	);
} finally {
	await vm.dispose();
}
