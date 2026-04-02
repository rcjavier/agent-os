import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentOs } from "../../packages/core/dist/agent-os.js";
import { AcpClient } from "../../packages/core/dist/acp-client.js";
import { createStdoutLineIterable } from "../../packages/core/dist/stdout-lines.js";
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
const XU_BIN_PATH = "/home/user/bin/xu";
const XU_COMMAND = "xu hello-agent-os";
const XU_PATH = "/home/user/bin:/usr/local/bin:/usr/bin:/bin";

const mock = new LLMock({ port: 0, logLevel: "silent" });
const hasToolResult = (req) =>
	Array.isArray(req?.messages) &&
	req.messages.some((message) => message?.role === "tool");

mock.addFixtures([
	{
		match: { predicate: (req) => !hasToolResult(req) },
		response: {
			toolCalls: [
				{
					name: "Bash",
					arguments: JSON.stringify({
						command: XU_COMMAND,
					}),
				},
			],
		},
	},
	{
		match: { predicate: hasToolResult },
		response: { content: "xu command executed successfully inside Agent OS." },
	},
]);

const mockUrl = await mock.start();
const mockPort = Number(new URL(mockUrl).port);

const vm = await AgentOs.create({
	loopbackExemptPorts: [mockPort],
	moduleAccessCwd: MODULE_ACCESS_CWD,
	software,
});
await vm.writeFile("/home/user/.claude/settings.json", "{}\n");
await vm.writeFile(
	"/home/user/.claude/plugins/installed_plugins.json",
	'{\n  "version": 2,\n  "plugins": {}\n}\n',
);
await vm.writeFiles([
	{
		path: XU_BIN_PATH,
		content: "#!/bin/bash\nprintf 'xu-ok:%s\\n' \"$*\"\n",
	},
]);
await vm.exec(`chmod +x ${XU_BIN_PATH}`);

const hostPkgJson = join(
	MODULE_ACCESS_CWD,
	"node_modules/@rivet-dev/agent-os-claude/package.json",
);
const pkg = JSON.parse(readFileSync(hostPkgJson, "utf-8"));
const binEntry =
	typeof pkg.bin === "string"
		? pkg.bin
		: pkg.bin["claude-sdk-acp"] ?? Object.values(pkg.bin)[0];
const binPath = `/root/node_modules/@rivet-dev/agent-os-claude/${binEntry}`;

const { iterable, onStdout } = createStdoutLineIterable();
let stderrOutput = "";
const proc = vm.kernel.spawn("node", [binPath], {
	streamStdin: true,
	onStdout,
	onStderr: (data) => {
		const text = new TextDecoder().decode(data);
		stderrOutput += text;
	},
	env: {
		ANTHROPIC_API_KEY: "mock-key",
		ANTHROPIC_BASE_URL: mockUrl,
		CLAUDE_AGENT_SDK_CLIENT_APP: "agent-os-test",
		HOME: "/home/user",
		CLAUDE_CODE_FORCE_AGENT_OS_RIPGREP: "1",
		CLAUDE_CODE_DEFER_GROWTHBOOK_INIT: "1",
		CLAUDE_CODE_DISABLE_STREAM_JSON_HOOK_EVENTS: "1",
		CLAUDE_CODE_SKIP_INITIAL_MESSAGES: "1",
		CLAUDE_CODE_SKIP_SANDBOX_INIT: "1",
		DISABLE_TELEMETRY: "1",
		PATH: XU_PATH,
		USE_BUILTIN_RIPGREP: "0",
	},
});

const client = new AcpClient(proc, iterable, { timeoutMs: 45_000 });
const notifications = [];
const permissionResponses = [];
let activeSessionId;

client.onNotification((notification) => {
	notifications.push(notification);
	console.log("NOTIFY", notification.method, JSON.stringify(notification.params));
	if (notification.method === "request/permission") {
		const params = notification.params;
		permissionResponses.push(
			client.request("request/permission", {
				sessionId: activeSessionId,
				permissionId: params.permissionId,
				reply: "once",
			}),
		);
	}
});

try {
	console.log(
		"INIT",
		JSON.stringify(
			await client.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			}),
		),
	);
	const sessionResponse = await client.request("session/new", {
		cwd: "/home/user",
		mcpServers: [],
	});
	console.log("SESSION", JSON.stringify(sessionResponse));
	const sessionId = sessionResponse.result.sessionId;
	activeSessionId = sessionId;

	try {
		const promptRequest = client.request("session/prompt", {
			sessionId,
			prompt: [
				{
					type: "text",
					text: `Run ${XU_COMMAND} and summarize what it prints.`,
				},
			],
		});
		const promptResult = await Promise.race([
			promptRequest.then((response) => ({ done: true, response })),
			new Promise((resolve) => {
				setTimeout(() => resolve({ done: false }), 15_000);
			}),
		]);
		if (promptResult.done) {
			console.log("PROMPT", JSON.stringify(promptResult.response));
		} else {
			console.log("PROMPT_TIMEOUT_PENDING");
			console.log("REQUEST_COUNT_EARLY", mock.getRequests().length);
			console.log("REQUESTS_EARLY", JSON.stringify(mock.getRequests(), null, 2));
		}
	} catch (error) {
		console.log("PROMPT_ERR", String(error));
	}
	await Promise.all(permissionResponses);
	console.log("NOTIFICATIONS", JSON.stringify(notifications, null, 2));
	console.log("REQUEST_COUNT", mock.getRequests().length);
	console.log("REQUESTS", JSON.stringify(mock.getRequests(), null, 2));
	const sdkDebugLogPath =
		stderrOutput.match(/SDK debug logs: ([^\n]+)/)?.[1]?.trim() ?? null;
	if (sdkDebugLogPath) {
		try {
			const sdkDebugLog = new TextDecoder().decode(
				await vm.readFile(sdkDebugLogPath),
			);
			console.log("SDK_DEBUG_LOG_START");
			console.log(sdkDebugLog);
			console.log("SDK_DEBUG_LOG_END");
		} catch (error) {
			console.log("SDK_DEBUG_LOG_ERR", String(error));
		}
	}
	console.log("STDERR_START");
	console.log(stderrOutput);
	console.log("STDERR_END");
} finally {
	console.log("CLEANUP client.close start");
	client.close();
	console.log("CLEANUP client.close done");
	console.log("CLEANUP vm.dispose start");
	await vm.dispose();
	console.log("CLEANUP vm.dispose done");
	console.log("CLEANUP mock.stop start");
	await mock.stop();
	console.log("CLEANUP mock.stop done");
	const handles = process._getActiveHandles().map((handle) => ({
		name: handle?.constructor?.name ?? typeof handle,
		address:
			typeof handle?.address === "function" ? handle.address() : undefined,
		listening:
			typeof handle?.listening === "boolean" ? handle.listening : undefined,
	}));
	const requests = process
		._getActiveRequests()
		.map((request) => request?.constructor?.name ?? typeof request);
	console.log("ACTIVE_HANDLES", JSON.stringify(handles));
	console.log("ACTIVE_REQUESTS", JSON.stringify(requests));
}
