import { afterEach, expect, it } from "vitest";
import {
	allowAllEnv,
	allowAllFs,
	createInMemoryFileSystem,
	type ExecOptions,
	type ExecResult,
	type NodeRuntimeDriver,
	type PythonRunOptions,
	type PythonRunResult,
	type PythonRuntimeDriver,
	type StdioEvent,
	type StdioHook,
	type SystemDriver,
} from "@secure-exec/core";
import { createNodeDriver } from "@secure-exec/nodejs";

type NodeRuntimeLike = NodeRuntimeDriver;
type PythonRuntimeLike = PythonRuntimeDriver;

export type PythonCreateRuntimeOptions = {
	cpuTimeLimitMs?: number;
	onStdio?: StdioHook;
	systemDriver?: SystemDriver;
};

export type PythonSuiteContext = {
	createNodeRuntime(options?: PythonCreateRuntimeOptions): Promise<NodeRuntimeLike>;
	createPythonRuntime(
		options?: PythonCreateRuntimeOptions,
	): Promise<PythonRuntimeLike>;
	teardown(): Promise<void>;
};

function collectMessages(events: StdioEvent[]): string[] {
	return events.map((event) => `${event.channel}:${event.message}`);
}

async function readPythonEnv(
	runtime: PythonRuntimeLike,
	key: string,
): Promise<PythonRunResult<string>> {
	return runtime.run<string>(`import os\nos.environ.get(${JSON.stringify(key)}, "missing")`);
}

export function runPythonParitySuite(context: PythonSuiteContext): void {
	afterEach(async () => {
		await context.teardown();
	});

	it("returns the same base exec success contract", async () => {
		const [node, python] = await Promise.all([
			context.createNodeRuntime(),
			context.createPythonRuntime(),
		]);

		const [nodeResult, pythonResult] = await Promise.all([
			node.exec(`console.log("ok")`),
			python.exec(`print("ok")`),
		]);

		expect(nodeResult.code).toBe(0);
		expect(pythonResult.code).toBe(0);
		expect(nodeResult.errorMessage).toBeUndefined();
		expect(pythonResult.errorMessage).toBeUndefined();
		expect(nodeResult).not.toHaveProperty("stdout");
		expect(pythonResult).not.toHaveProperty("stdout");
	});

	it("returns the same base exec timeout contract", async () => {
		const [node, python] = await Promise.all([
			context.createNodeRuntime({ cpuTimeLimitMs: 60 }),
			context.createPythonRuntime({ cpuTimeLimitMs: 60 }),
		]);

		const [nodeResult, pythonResult] = await Promise.all([
			node.exec(`while (true) {}`),
			python.exec("while True:\n  pass"),
		]);

		expect(nodeResult.code).toBe(124);
		expect(pythonResult.code).toBe(124);
		expect(nodeResult.errorMessage).toContain("CPU time limit exceeded");
		expect(pythonResult.errorMessage).toContain("CPU time limit exceeded");
	});
}

export function runPythonRuntimeSuite(context: PythonSuiteContext): void {
	afterEach(async () => {
		await context.teardown();
	});

	it("returns success for valid python exec", async () => {
		const runtime = await context.createPythonRuntime();
		const events: StdioEvent[] = [];
		const result = await runtime.exec('print("python-suite-ok")', {
			onStdio: (event) => events.push(event),
		});
		expect(result.code).toBe(0);
		expect(result.errorMessage).toBeUndefined();
		expect(collectMessages(events).join("\n")).toContain("python-suite-ok");
	});

	it("returns deterministic error contract for python exceptions", async () => {
		const runtime = await context.createPythonRuntime();
		const result = await runtime.exec('raise Exception("boom")');
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("boom");
	});

	it("returns a structured run wrapper with serialized globals", async () => {
		const runtime = await context.createPythonRuntime();
		const result = await runtime.run<number>(
			"shared_counter = 41\nshared_counter + 1",
			{
				globals: ["shared_counter"],
			},
		);
		expect(result.code).toBe(0);
		expect(result.value).toBe(42);
		expect(result.globals).toEqual({ shared_counter: 41 });
		expect(result).not.toHaveProperty("exports");
	});

	it("keeps warm interpreter state across exec and run calls", async () => {
		const runtime = await context.createPythonRuntime();
		const first = await runtime.exec('shared_state = "warm"');
		expect(first.code).toBe(0);

		const second = await runtime.run<string>("shared_state");
		expect(second.code).toBe(0);
		expect(second.value).toBe("warm");
	});

	it("exposes only the supported secure_exec hooks", async () => {
		const runtime = await context.createPythonRuntime();
		const result = await runtime.run<string>(
			'import json\nimport secure_exec\njson.dumps([hasattr(secure_exec, "read_text_file"), hasattr(secure_exec, "fetch"), hasattr(secure_exec, "install_package"), hasattr(secure_exec, "spawn")])',
		);
		expect(result.code).toBe(0);
		expect(result.value).toBe("[true, true, false, false]");
	});

	it("reads files through the configured SystemDriver filesystem when permitted", async () => {
		const filesystem = createInMemoryFileSystem();
		await filesystem.writeFile("/tmp/python-suite.txt", "python-fs-ok");

		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				filesystem,
				permissions: allowAllFs,
			}),
		});

		const events: StdioEvent[] = [];
		const result = await runtime.exec(
			'from secure_exec import read_text_file\nprint(await read_text_file("/tmp/python-suite.txt"))',
			{
				onStdio: (event) => events.push(event),
			},
		);

		expect(result.code).toBe(0);
		expect(collectMessages(events)).toContain("stdout:python-fs-ok");
	});

	it("denies filesystem access by default when fs permissions are absent", async () => {
		const filesystem = createInMemoryFileSystem();
		await filesystem.writeFile("/tmp/python-suite.txt", "python-fs-ok");

		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				filesystem,
			}),
		});

		const result = await runtime.exec(
			'from secure_exec import read_text_file\nawait read_text_file("/tmp/python-suite.txt")',
		);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("EACCES");
	});

	it("reports ENOSYS for filesystem access when no adapter is configured", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: {
				runtime: {
					process: {},
					os: {},
				},
			},
		});

		const result = await runtime.exec(
			'from secure_exec import read_text_file\nawait read_text_file("/tmp/python-suite.txt")',
		);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("ENOSYS");
	});

	it("filters base SystemDriver env by default when env permissions are absent", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				processConfig: {
					env: {
						SECRET_TOKEN: "top-secret",
					},
				},
			}),
		});

		const result = await readPythonEnv(runtime, "SECRET_TOKEN");
		expect(result.code).toBe(0);
		expect(result.value).toBe("missing");
	});

	it("exposes permitted base SystemDriver env inside the runtime", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				permissions: allowAllEnv,
				processConfig: {
					env: {
						SECRET_TOKEN: "top-secret",
					},
				},
			}),
		});

		const result = await readPythonEnv(runtime, "SECRET_TOKEN");
		expect(result.code).toBe(0);
		expect(result.value).toBe("top-secret");
	});

	it("filters exec env overrides through env permissions by default", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({}),
		});
		const events: StdioEvent[] = [];
		const result = await runtime.exec(
			'import os\nprint(os.environ.get("SECRET_TOKEN", "missing"))',
			{
				env: {
					SECRET_TOKEN: "top-secret",
				},
				onStdio: (event) => events.push(event),
			},
		);
		expect(result.code).toBe(0);
		expect(collectMessages(events)).toContain("stdout:missing");
	});

	it("applies permitted exec env and cwd overrides to one call and restores state afterward", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				filesystem: createInMemoryFileSystem(),
				permissions: allowAllEnv,
			}),
		});

		const initialCwd = await runtime.run<string>("import os\nos.getcwd()");
		expect(initialCwd.code).toBe(0);

		const overrideCwd = "/tmp/python-suite-cwd";
		const mkdirResult = await runtime.exec(
			`import os\nos.makedirs(${JSON.stringify(overrideCwd)}, exist_ok=True)`,
		);
		expect(mkdirResult.code).toBe(0);

		const events: StdioEvent[] = [];
		const overridden = await runtime.exec(
			'import os\nprint(input())\nprint(os.environ.get("SECRET_TOKEN", "missing"))\nprint(os.getcwd())',
			{
				stdin: "hello-from-stdin",
				cwd: overrideCwd,
				env: {
					SECRET_TOKEN: "top-secret",
				},
				onStdio: (event) => events.push(event),
			},
		);
		expect(overridden.code).toBe(0);
		expect(collectMessages(events)).toContain("stdout:hello-from-stdin");
		expect(collectMessages(events)).toContain("stdout:top-secret");
		expect(collectMessages(events)).toContain(`stdout:${overrideCwd}`);

		const restoredCwd = await runtime.run<string>("import os\nos.getcwd()");
		expect(restoredCwd.code).toBe(0);
		expect(restoredCwd.value).toBe(initialCwd.value);

		const restoredEnv = await readPythonEnv(runtime, "SECRET_TOKEN");
		expect(restoredEnv.code).toBe(0);
		expect(restoredEnv.value).toBe("missing");
	});

	it("maps cpu timeouts to the shared timeout contract", async () => {
		const runtime = await context.createPythonRuntime({ cpuTimeLimitMs: 50 });
		const result = await runtime.exec("while True:\n  pass");
		expect(result.code).toBe(124);
		expect(result.errorMessage).toContain("CPU time limit exceeded");
	});

	it("does not retain unbounded stdout/stderr buffers in exec results", async () => {
		const runtime = await context.createPythonRuntime();
		const events: string[] = [];
		const result = await runtime.exec(
			'for i in range(2500):\n  print("line-" + str(i))',
			{
				onStdio: (event) => {
					events.push(event.message);
				},
			},
		);
		expect(result.code).toBe(0);
		expect(events.length).toBeGreaterThan(0);
		expect(result).not.toHaveProperty("stdout");
		expect(result).not.toHaveProperty("stderr");
	});

	it("fails package installation pathways deterministically", async () => {
		const runtime = await context.createPythonRuntime();
		const result = await runtime.exec("import micropip");
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain(
			"ERR_PYTHON_PACKAGE_INSTALL_UNSUPPORTED",
		);
	});

	it("recovers after timeout and can execute again", async () => {
		const runtime = await context.createPythonRuntime({ cpuTimeLimitMs: 40 });
		const timedOut = await runtime.exec("while True:\n  pass");
		expect(timedOut.code).toBe(124);

		const recovered = await runtime.exec('print("recovered")');
		expect(recovered.code).toBe(0);
	});
}
