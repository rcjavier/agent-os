import { afterEach, expect, it } from "vitest";
import { allowAllNetwork } from "@secure-exec/core";
import { createNodeDriver } from "@secure-exec/nodejs";
import type { PythonSuiteContext } from "./runtime.js";

export function runPythonNetworkSuite(context: PythonSuiteContext): void {
	afterEach(async () => {
		await context.teardown();
	});

	it("fetches through the configured SystemDriver network adapter when permitted", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				useDefaultNetwork: true,
				permissions: allowAllNetwork,
			}),
		});

		const result = await runtime.run<string>(
			'import secure_exec\nresponse = await secure_exec.fetch("data:text/plain,python-network-ok")\nresponse.body',
		);

		expect(result.code).toBe(0);
		expect(result.value).toBe("python-network-ok");
	});

	it("denies network access by default when network permissions are absent", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: createNodeDriver({
				useDefaultNetwork: true,
			}),
		});

		const result = await runtime.exec(
			'import secure_exec\nawait secure_exec.fetch("data:text/plain,blocked")',
		);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("EACCES");
	});

	it("reports ENOSYS for network access when no adapter is configured", async () => {
		const runtime = await context.createPythonRuntime({
			systemDriver: {
				runtime: {
					process: {},
					os: {},
				},
			},
		});

		const result = await runtime.exec(
			'import secure_exec\nawait secure_exec.fetch("data:text/plain,blocked")',
		);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("ENOSYS");
	});
}
