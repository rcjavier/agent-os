import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { AgentOs } from "../../packages/core/dist/agent-os.js";
import coreutils from "../../registry/software/coreutils/dist/index.js";
import sed from "../../registry/software/sed/dist/index.js";
import grep from "../../registry/software/grep/dist/index.js";
import gawk from "../../registry/software/gawk/dist/index.js";
import findutils from "../../registry/software/findutils/dist/index.js";
import diffutils from "../../registry/software/diffutils/dist/index.js";
import tar from "../../registry/software/tar/dist/index.js";
import gzip from "../../registry/software/gzip/dist/index.js";
import jq from "../../registry/software/jq/dist/index.js";
import ripgrep from "../../registry/software/ripgrep/dist/index.js";
import fd from "../../registry/software/fd/dist/index.js";
import tree from "../../registry/software/tree/dist/index.js";
import file from "../../registry/software/file/dist/index.js";
import yq from "../../registry/software/yq/dist/index.js";
import codex from "../../registry/software/codex/dist/index.js";
import curl from "../../registry/software/curl/dist/index.js";

const require = createRequire(import.meta.url);
const { LLMock } = require(
	"../../node_modules/.pnpm/@copilotkit+llmock@1.6.0/node_modules/@copilotkit/llmock/dist/index.cjs",
);

const MODULE_ACCESS_CWD = resolve(import.meta.dirname, "../../packages/core");
const software = [
	coreutils,
	sed,
	grep,
	gawk,
	findutils,
	diffutils,
	tar,
	gzip,
	jq,
	ripgrep,
	fd,
	tree,
	file,
	yq,
	codex,
	curl,
];

const mock = new LLMock({ port: 0, logLevel: "debug" });
const hasToolResult = (req) => JSON.stringify(req).includes('"tool_result"');

mock.addFixtures([
	{
		match: { predicate: (req) => !hasToolResult(req) },
		response: {
			toolCalls: [
				{
					name: "Bash",
					arguments: JSON.stringify({
						command: "rg -n --no-heading hello-claude-grep /home/user",
					}),
				},
			],
		},
	},
	{
		match: { predicate: hasToolResult },
		response: { content: "Found hello-claude-grep in the workspace." },
	},
]);

const mockUrl = await mock.start();
const mockPort = Number(new URL(mockUrl).port);

const vm = await AgentOs.create({
	loopbackExemptPorts: [mockPort],
	moduleAccessCwd: MODULE_ACCESS_CWD,
	software,
});

try {
	await vm.writeFile("/home/user/.claude/settings.json", "{}\n");
	await vm.writeFile(
		"/home/user/.claude/plugins/installed_plugins.json",
		'{\n  "version": 2,\n  "plugins": {}\n}\n',
	);
	await vm.writeFile(
		"/home/user/needle.txt",
		"before\nhello-claude-grep\nafter\n",
	);

	const hostPkgJson = join(
		MODULE_ACCESS_CWD,
		"node_modules/@rivet-dev/agent-os-claude/package.json",
	);
	const pkg = JSON.parse(readFileSync(hostPkgJson, "utf-8"));
	const cliManifestPath = join(
		MODULE_ACCESS_CWD,
		"node_modules/@rivet-dev/agent-os-claude/dist/claude-cli-patched.json",
	);
	const manifest = JSON.parse(readFileSync(cliManifestPath, "utf-8"));
	const cliPath = `/root/node_modules/@rivet-dev/agent-os-claude/dist/${manifest.entry.replace("./", "")}`;
	const binEntry =
		typeof pkg.bin === "string"
			? pkg.bin
			: pkg.bin["claude-sdk-acp"] ?? Object.values(pkg.bin)[0];
	void binEntry;

	await vm.writeFile(
		"/tmp/claude-direct-wrapper.mjs",
		[
			'import { appendFileSync } from "node:fs";',
			`const cliPath = ${JSON.stringify(cliPath)};`,
			'const realStdout = process.stdout;',
			'const realStderr = process.stderr;',
			'appendFileSync("/tmp/wrapper.log", "wrapper_start\\n");',
			'process.on("uncaughtException", (error) => {',
			'  appendFileSync("/tmp/wrapper.log", "uncaught " + String(error?.stack ?? error) + "\\n");',
			'});',
			'process.on("unhandledRejection", (error) => {',
			'  appendFileSync("/tmp/wrapper.log", "rejection " + String(error?.stack ?? error) + "\\n");',
			'});',
			'process.on("exit", (code) => {',
			'  appendFileSync("/tmp/wrapper.log", "wrapper_exit " + String(code) + "\\n");',
			'});',
			'Object.defineProperty(process, "stdout", { configurable: true, enumerable: true, value: realStderr });',
			'Object.defineProperty(process, "stderr", { configurable: true, enumerable: true, value: realStdout });',
			'import(cliPath).catch((error) => {',
			'  appendFileSync("/tmp/wrapper.log", "wrapper_import_error " + String(error?.stack ?? error) + "\\n");',
			'  throw error;',
			'});',
		].join("\n"),
	);

	await vm.writeFile(
		"/tmp/parent.mjs",
		[
			'import { appendFileSync, writeFileSync } from "node:fs";',
			'import { spawn } from "node:child_process";',
			'writeFileSync("/tmp/parent.log", "parent_start\\n");',
			'writeFileSync("/tmp/child-stdout.log", "");',
			'writeFileSync("/tmp/child-stderr.log", "");',
			'const args = [',
			'  "/tmp/claude-direct-wrapper.mjs",',
			'  "--output-format", "stream-json",',
			'  "--verbose",',
			'  "--input-format", "stream-json",',
			'  "--debug-to-stderr",',
			'  "--permission-prompt-tool", "stdio",',
			'  "--tools", "default",',
			'  "--setting-sources", "project",',
			'  "--permission-mode", "default",',
			'  "--include-partial-messages",',
			'  "--no-session-persistence",',
			'  "--bare",',
			'  "--settings", JSON.stringify({ sandbox: { enabled: false } }),',
			'];',
			'const child = spawn("node", args, {',
			'  cwd: "/home/user",',
			'  env: {',
			'    ...process.env,',
			`    ANTHROPIC_API_KEY: "mock-key",`,
			`    ANTHROPIC_BASE_URL: ${JSON.stringify(mockUrl)},`,
			'    CLAUDE_AGENT_SDK_CLIENT_APP: "agent-os-test",',
			'    CLAUDE_CODE_FORCE_AGENT_OS_RIPGREP: "1",',
			'    CLAUDE_CODE_DEFER_GROWTHBOOK_INIT: "1",',
			'    CLAUDE_CODE_DISABLE_STREAM_JSON_HOOK_EVENTS: "1",',
			'    CLAUDE_CODE_IGNORE_STARTUP_EXIT_CODE: "1",',
			'    CLAUDE_CODE_SKIP_INITIAL_MESSAGES: "1",',
			'    CLAUDE_CODE_SKIP_SANDBOX_INIT: "1",',
			'    DEBUG_CLAUDE_AGENT_SDK: "1",',
			'    DISABLE_TELEMETRY: "1",',
			'    HOME: "/home/user",',
			'    USE_BUILTIN_RIPGREP: "0",',
			'  },',
			'  stdio: ["pipe", "pipe", "pipe"],',
			'});',
			'appendFileSync("/tmp/parent.log", "spawned\\n");',
			'child.stdout.on("data", (chunk) => appendFileSync("/tmp/child-stdout.log", String(chunk)));',
			'child.stderr.on("data", (chunk) => appendFileSync("/tmp/child-stderr.log", String(chunk)));',
			'child.on("error", (error) => appendFileSync("/tmp/parent.log", "error " + String(error?.stack ?? error) + "\\n"));',
			'child.on("exit", (code, signal) => appendFileSync("/tmp/parent.log", `exit ${code} ${signal}\\n`));',
			'child.stdin.write(JSON.stringify({ request_id: "init-1", type: "control_request", request: { subtype: "initialize" } }) + "\\n");',
			'child.stdin.write(JSON.stringify({ type: "user", session_id: "", message: { role: "user", content: [{ type: "text", text: "Run rg -n --no-heading hello-claude-grep /home/user and summarize what you find." }] }, parent_tool_use_id: null }) + "\\n");',
			'setTimeout(() => appendFileSync("/tmp/parent.log", "waited_10s\\n"), 10000);',
			'setTimeout(() => appendFileSync("/tmp/parent.log", "waited_20s\\n"), 20000);',
			'setTimeout(() => { child.kill("SIGTERM"); appendFileSync("/tmp/parent.log", "killed\\n"); }, 30000);',
		].join("\n"),
	);

	let stdout = "";
	let stderr = "";
	const proc = vm.kernel.spawn("node", ["/tmp/parent.mjs"], {
		onStdout: (data) => {
			stdout += new TextDecoder().decode(data);
		},
		onStderr: (data) => {
			stderr += new TextDecoder().decode(data);
		},
		env: { HOME: "/home/user" },
	});
	const exitCode = await proc.wait();

	const [parentLog, childStdout, childStderr, wrapperLog] = await Promise.all([
		vm.readFile("/tmp/parent.log").catch(() => new Uint8Array()),
		vm.readFile("/tmp/child-stdout.log").catch(() => new Uint8Array()),
		vm.readFile("/tmp/child-stderr.log").catch(() => new Uint8Array()),
		vm.readFile("/tmp/wrapper.log").catch(() => new Uint8Array()),
	]);

	console.log(
		JSON.stringify(
			{
				exitCode,
				stdout,
				stderr,
				parentLog: new TextDecoder().decode(parentLog),
				childStdout: new TextDecoder().decode(childStdout),
				childStderr: new TextDecoder().decode(childStderr),
				wrapperLog: new TextDecoder().decode(wrapperLog),
				requestCount: mock.getRequests().length,
				requests: mock.getRequests(),
			},
			null,
			2,
		),
	);
} finally {
	await vm.dispose();
	await mock.stop();
}
