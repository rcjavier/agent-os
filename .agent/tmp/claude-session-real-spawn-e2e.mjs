import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentOs } from "../../packages/core/dist/agent-os.js";
import claude from "../../registry/agent/claude/dist/index.js";
import coreutils from "../../registry/software/coreutils/dist/index.js";
import ripgrep from "../../registry/software/ripgrep/dist/index.js";

const ASYNC_SPAWN_SCRIPT_PATH = "/tmp/async-spawn.cjs";
const ASYNC_SPAWN_SCRIPT = `
const { spawn } = require("child_process");

const child = spawn("sh", ["-lc", "echo async-ok"], {
	stdio: ["ignore", "pipe", "inherit"],
});

child.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
});

child.on("close", (code) => {
	process.exit(code ?? 0);
});
`.trimStart();

function loadEnvTokens() {
	const envPath = join(homedir(), "misc", "env.txt");
	const content = readFileSync(envPath, "utf-8");
	const tokens = {};

	for (const line of content.split("\n")) {
		const match = line.match(/^export\s+(\w+)=(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		tokens[match[1]] = value;
	}

	return tokens;
}

function collectAssistantText(notifications) {
	return notifications
		.filter((notification) => notification.method === "session/update")
		.map((notification) => {
			const params = notification.params ?? {};
			const update = params.update ?? params;
			if (
				update.sessionUpdate === "agent_message_chunk" &&
				update.content?.type === "text" &&
				typeof update.content.text === "string"
			) {
				return update.content.text;
			}
			return "";
		})
		.join("");
}

function countUpdateKind(notifications, kind) {
	return notifications.filter((notification) => {
		if (notification.method !== "session/update") return false;
		const params = notification.params ?? {};
		const update = params.update ?? params;
		return update.sessionUpdate === kind;
	}).length;
}

function summarizeNotifications(notifications) {
	return notifications
		.filter((notification) => notification.method === "session/update")
		.map((notification) => {
			const params = notification.params ?? {};
			const update = params.update ?? params;
			return String(update.sessionUpdate ?? update.type ?? "unknown");
		})
		.slice(-20);
}

const tokens = loadEnvTokens();
if (!tokens.ANTHROPIC_API_KEY) {
	throw new Error("ANTHROPIC_API_KEY not found in ~/misc/env.txt");
}

const cliArgs = process.argv.slice(2);
const useAsyncSpawnScript = cliArgs.includes("--async-spawn-script");
const promptArg = cliArgs.find((arg) => !arg.startsWith("--"));
const moduleAccessCwd = resolve(import.meta.dirname, "../../packages/core");
const vm = await AgentOs.create({
	moduleAccessCwd,
	software: [claude, coreutils, ripgrep],
});

let sessionId;
const permissionRequests = [];
const startedAt = Date.now();
let stage = "boot";
const promptText =
	promptArg ??
	(useAsyncSpawnScript
		? `Run \`node ${ASYNC_SPAWN_SCRIPT_PATH}\` inside the Agent OS shell. You must actually execute the command. Reply with the exact stdout only and no markdown.`
		: 'Run `node -e "process.stdout.write(\\"spawn-ok\\\\n\\")"` inside the Agent OS shell. ' +
				"You must actually execute the command. " +
				"Reply with the exact stdout only and no markdown.");

try {
	if (useAsyncSpawnScript) {
		stage = "writeAsyncSpawnScript";
		await vm.writeFile(ASYNC_SPAWN_SCRIPT_PATH, ASYNC_SPAWN_SCRIPT);
	}

	stage = "createSession";
	const session = await vm.createSession("claude", {
		cwd: "/home/user",
		env: {
			ANTHROPIC_API_KEY: tokens.ANTHROPIC_API_KEY,
		},
	});
	sessionId = session.sessionId;
	stage = "sessionCreated";

	vm.onPermissionRequest(sessionId, (request) => {
		permissionRequests.push({
			permissionId: request.permissionId,
			description: request.description ?? null,
		});
		void vm.respondPermission(sessionId, request.permissionId, "once");
	});

	stage = "prompt";
	const response = await vm.prompt(sessionId, promptText);
	stage = "promptCompleted";
	const notifications = vm
		.getSessionEvents(sessionId)
		.map((entry) => entry.notification);
	const assistantText = collectAssistantText(notifications);

	console.log(
		JSON.stringify(
			{
				ok: !response.error,
				sessionId,
				error: response.error ?? null,
				result: response.result ?? null,
				stopReason: response.result?.stopReason ?? null,
				assistantText,
				permissionRequestCount: permissionRequests.length,
				permissionRequests,
				promptText,
				toolCallCount: notifications.filter((notification) => {
					if (notification.method !== "session/update") return false;
					const params = notification.params ?? {};
					const update = params.update ?? params;
					return update.sessionUpdate === "tool_call";
				}).length,
				toolCallUpdateCount: countUpdateKind(
					notifications,
					"tool_call_update",
				),
				messageChunkCount: countUpdateKind(
					notifications,
					"agent_message_chunk",
				),
				recentSessionUpdates: summarizeNotifications(notifications),
				elapsedMs: Date.now() - startedAt,
			},
			null,
			2,
		),
	);
} catch (error) {
	const notifications = sessionId
		? vm.getSessionEvents(sessionId).map((entry) => entry.notification)
		: [];
	console.log(
		JSON.stringify(
			{
				ok: false,
				stage,
				sessionId: sessionId ?? null,
				error: error instanceof Error ? error.message : String(error),
				assistantText: collectAssistantText(notifications),
				permissionRequestCount: permissionRequests.length,
				permissionRequests,
				promptText,
				toolCallCount: countUpdateKind(notifications, "tool_call"),
				toolCallUpdateCount: countUpdateKind(
					notifications,
					"tool_call_update",
				),
				messageChunkCount: countUpdateKind(
					notifications,
					"agent_message_chunk",
				),
				recentSessionUpdates: summarizeNotifications(notifications),
				elapsedMs: Date.now() - startedAt,
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
} finally {
	if (sessionId) {
		vm.closeSession(sessionId);
	}
	await vm.dispose();
}
