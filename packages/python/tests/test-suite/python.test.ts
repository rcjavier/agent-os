import { describe } from "vitest";
import { allowAll } from "@secure-exec/core";
import {
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "@secure-exec/nodejs";
import { createPyodideRuntimeDriverFactory } from "../../src/driver.ts";
import {
	runPythonNetworkSuite,
} from "./python/network.js";
import {
	runPythonParitySuite,
	runPythonRuntimeSuite,
	type PythonCreateRuntimeOptions,
	type PythonSuiteContext,
} from "./python/runtime.js";

type DisposableRuntime = {
	dispose(): void;
	terminate(): Promise<void>;
};

function isNodeTargetAvailable(): boolean {
	return typeof process !== "undefined" && Boolean(process.versions?.node);
}

function createPythonSuiteContext(): PythonSuiteContext {
	const runtimes = new Set<DisposableRuntime>();

	return {
		async teardown(): Promise<void> {
			const runtimeList = Array.from(runtimes);
			runtimes.clear();

			for (const runtime of runtimeList) {
				try {
					await runtime.terminate();
				} catch {
					runtime.dispose();
				}
			}
		},
		async createNodeRuntime(options: PythonCreateRuntimeOptions = {}) {
			const { systemDriver, ...runtimeOptions } = options;
			const effectiveSystemDriver =
				systemDriver ??
				createNodeDriver({
					useDefaultNetwork: true,
					permissions: allowAll,
				});
			const runtime = createNodeRuntimeDriverFactory().createRuntimeDriver({
				...runtimeOptions,
				system: effectiveSystemDriver,
				runtime: effectiveSystemDriver.runtime,
			});
			runtimes.add(runtime);
			return runtime;
		},
		async createPythonRuntime(options: PythonCreateRuntimeOptions = {}) {
			const { systemDriver, ...runtimeOptions } = options;
			const effectiveSystemDriver =
				systemDriver ??
				createNodeDriver({
					useDefaultNetwork: true,
					permissions: allowAll,
				});
			const runtime = createPyodideRuntimeDriverFactory().createRuntimeDriver({
				...runtimeOptions,
				system: effectiveSystemDriver,
				runtime: effectiveSystemDriver.runtime,
			});
			runtimes.add(runtime);
			return runtime;
		},
	};
}

describe.skipIf(!isNodeTargetAvailable())("python runtime integration suite", () => {
	const context = createPythonSuiteContext();
	runPythonParitySuite(context);
	runPythonRuntimeSuite(context);
	runPythonNetworkSuite(context);
});
