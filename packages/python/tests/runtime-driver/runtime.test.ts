import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllEnv,
	allowAllNetwork,
	createInMemoryFileSystem,
	type RuntimeDriverOptions,
} from "@secure-exec/core";
import { createNodeDriver } from "@secure-exec/nodejs";
import { PyodideRuntimeDriver } from "../../src/driver.ts";

type RuntimeOptions = Pick<RuntimeDriverOptions, "cpuTimeLimitMs" | "onStdio">;

describe("runtime driver specific: python", () => {
	const runtimes = new Set<PyodideRuntimeDriver>();

	const createRuntime = (options: RuntimeOptions = {}): PyodideRuntimeDriver => {
		const systemDriver = createNodeDriver({
			filesystem: createInMemoryFileSystem(),
		});
		const runtime = new PyodideRuntimeDriver({
			...options,
			system: systemDriver,
			runtime: systemDriver.runtime,
		});
		runtimes.add(runtime);
		return runtime;
	};

	afterEach(async () => {
		const runtimeList = Array.from(runtimes);
		runtimes.clear();

		for (const runtime of runtimeList) {
			try {
				await runtime.terminate();
			} catch {
				runtime.dispose();
			}
		}
	});

	it("returns a structured run result wrapper", async () => {
		const runtime = createRuntime();
		const result = await runtime.run("1 + 2");
		expect(result.code).toBe(0);
		expect(result.value).toBe(3);
		expect(result).not.toHaveProperty("exports");
	});

	it("keeps warm state across runs", async () => {
		const runtime = createRuntime();
		const first = await runtime.run("shared_counter = 41");
		expect(first.code).toBe(0);

		const second = await runtime.run("shared_counter + 1");
		expect(second.code).toBe(0);
		expect(second.value).toBe(42);
	});

	it("exposes only the supported secure_exec capability hooks", async () => {
		const runtime = createRuntime();
		const result = await runtime.run<string>(
			'import json\nimport secure_exec\njson.dumps([hasattr(secure_exec, "read_text_file"), hasattr(secure_exec, "fetch"), hasattr(secure_exec, "install_package")])',
		);
		expect(result.code).toBe(0);
		expect(result.value).toBe("[true, true, false]");
	});

	it("streams stdio and applies run overrides without leaking them", async () => {
		const systemDriver = createNodeDriver({
				filesystem: createInMemoryFileSystem(),
				permissions: allowAllEnv,
		});
		const runtime = new PyodideRuntimeDriver({
			system: systemDriver,
			runtime: systemDriver.runtime,
		});
		runtimes.add(runtime);

		const initialCwd = await runtime.run<string>('import os\nos.getcwd()');
		expect(initialCwd.code).toBe(0);
		const overrideCwd = `${initialCwd.value}/secure-exec-run-cwd`;
		const mkdirResult = await runtime.exec(
			`import os\nos.makedirs(${JSON.stringify(overrideCwd)}, exist_ok=True)`,
		);
		expect(mkdirResult.code).toBe(0);

		const events: string[] = [];
		const result = await runtime.run<string>(
			'import os\nprint(input())\nprint(os.environ.get("SECRET_TOKEN", "missing"))\nos.getcwd()',
			{
				stdin: "hello-from-stdin",
				cwd: overrideCwd,
				env: {
					SECRET_TOKEN: "top-secret",
				},
				onStdio: (event) => events.push(`${event.channel}:${event.message}`),
			},
		);
		expect(result.code).toBe(0);
		expect(result.value).toBe(overrideCwd);
		expect(events).toContain("stdout:hello-from-stdin");
		expect(events).toContain("stdout:top-secret");

		const restoredCwd = await runtime.run<string>('import os\nos.getcwd()');
		expect(restoredCwd.code).toBe(0);
		expect(restoredCwd.value).toBe(initialCwd.value);

		const restoredEnv = await runtime.run<string>(
			'import os\nos.environ.get("SECRET_TOKEN", "missing")',
		);
		expect(restoredEnv.code).toBe(0);
		expect(restoredEnv.value).toBe("missing");
	});

	it("reuses system-driver permission gates for python-accessible fs hooks", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec(
			'from secure_exec import read_text_file\nawait read_text_file("/tmp/secret.txt")',
		);
		expect(result.code).not.toBe(0);
		expect(result.errorMessage).toContain("EACCES");
	});

	it("reports ENOSYS for python-accessible fs hooks when no filesystem adapter exists", async () => {
		const runtime = new PyodideRuntimeDriver({
			system: {
				runtime: {
					process: {},
					os: {},
				},
			},
			runtime: {
				process: {},
				os: {},
			},
		});
		runtimes.add(runtime);

		const result = await runtime.exec(
			'from secure_exec import read_text_file\nawait read_text_file("/tmp/secret.txt")',
		);
		expect(result.code).not.toBe(0);
		expect(result.errorMessage).toContain("ENOSYS");
	});

	it("reuses system-driver permission gates for python-accessible network hooks", async () => {
		const systemDriver = createNodeDriver({
				filesystem: createInMemoryFileSystem(),
				useDefaultNetwork: true,
		});
		const runtime = new PyodideRuntimeDriver({
			system: systemDriver,
			runtime: systemDriver.runtime,
		});
		runtimes.add(runtime);

		const result = await runtime.exec(
			'import secure_exec\nawait secure_exec.fetch("data:text/plain,blocked")',
		);
		expect(result.code).not.toBe(0);
		expect(result.errorMessage).toContain("EACCES");
	});

	it("reports ENOSYS for python-accessible network hooks when no adapter exists", async () => {
		const runtime = new PyodideRuntimeDriver({
			system: {
				runtime: {
					process: {},
					os: {},
				},
			},
			runtime: {
				process: {},
				os: {},
			},
		});
		runtimes.add(runtime);

		const result = await runtime.exec(
			'import secure_exec\nawait secure_exec.fetch("data:text/plain,blocked")',
		);
		expect(result.code).not.toBe(0);
		expect(result.errorMessage).toContain("ENOSYS");
	});

	it("allows python-accessible network hooks when permissions permit them", async () => {
		const systemDriver = createNodeDriver({
				filesystem: createInMemoryFileSystem(),
				useDefaultNetwork: true,
				permissions: allowAllNetwork,
		});
		const runtime = new PyodideRuntimeDriver({
			system: systemDriver,
			runtime: systemDriver.runtime,
		});
		runtimes.add(runtime);

		const result = await runtime.run<string>(
			'import secure_exec\nresponse = await secure_exec.fetch("data:text/plain,python-fetch-ok")\nresponse.body',
		);
		expect(result.code).toBe(0);
		expect(result.value).toBe("python-fetch-ok");
	});

	it("fails package install pathways deterministically", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec("import micropip");
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain(
			"ERR_PYTHON_PACKAGE_INSTALL_UNSUPPORTED",
		);
	});

	it("filters exec env overrides through env permissions by default", async () => {
		const runtime = createRuntime();
		const events: string[] = [];
		const result = await runtime.exec(
			'import os\nprint(os.environ.get("SECRET_TOKEN", "missing"))',
			{
				env: {
					SECRET_TOKEN: "top-secret",
				},
				onStdio: (event) => events.push(event.message),
			},
		);
		expect(result.code).toBe(0);
		expect(events).toContain("missing");
	});

	it("allows exec env overrides when env permissions permit them", async () => {
		const systemDriver = createNodeDriver({
				filesystem: createInMemoryFileSystem(),
				permissions: allowAllEnv,
		});
		const runtime = new PyodideRuntimeDriver({
			system: systemDriver,
			runtime: systemDriver.runtime,
		});
		runtimes.add(runtime);

		const events: string[] = [];
		const result = await runtime.exec(
			'import os\nprint(os.environ.get("SECRET_TOKEN", "missing"))',
			{
				env: {
					SECRET_TOKEN: "top-secret",
				},
				onStdio: (event) => events.push(event.message),
			},
		);
		expect(result.code).toBe(0);
		expect(events).toContain("top-secret");
	});

	it("recovers after run() timeouts and can execute again", async () => {
		const runtime = createRuntime({ cpuTimeLimitMs: 40 });
		const timedOut = await runtime.run("while True:\n  pass");
		expect(timedOut.code).toBe(124);
		expect(timedOut.errorMessage).toContain("CPU time limit exceeded");

		const recovered = await runtime.run("7");
		expect(recovered.code).toBe(0);
		expect(recovered.value).toBe(7);
	});

	// -----------------------------------------------------------------------
	// Host JS escape prevention
	// -----------------------------------------------------------------------

	it("blocks import js — prevents access to host JS runtime", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec("import js\nprint(js.globalThis)");
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("blocked in sandbox");
	});

	it("blocks import pyodide_js — prevents access to Pyodide JS internals", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec("import pyodide_js");
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("blocked in sandbox");
	});

	it("blocks from js import globalThis — attribute-level import bypass", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec("from js import globalThis");
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("blocked in sandbox");
	});

	it("blocks getattr-based js access", async () => {
		const runtime = createRuntime();
		const result = await runtime.exec(
			"import importlib\nm = importlib.import_module('js')\nprint(m.globalThis)",
		);
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("blocked in sandbox");
	});

	it("normal Python stdlib still works after js blocking", async () => {
		const runtime = createRuntime();
		const events: string[] = [];
		const result = await runtime.exec(
			"import math\nimport json\nimport re\nimport collections\nprint(json.dumps({'pi': round(math.pi, 4), 'match': bool(re.match('abc', 'abc')), 'counter': dict(collections.Counter('hello'))}))",
			{ onStdio: (event) => events.push(event.message) },
		);
		expect(result.code).toBe(0);
		const parsed = JSON.parse(events.join(""));
		expect(parsed.pi).toBeCloseTo(3.1416, 3);
		expect(parsed.match).toBe(true);
		expect(parsed.counter).toHaveProperty("l");
	});
});
