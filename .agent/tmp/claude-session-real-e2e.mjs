import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentOs } from "../../packages/core/dist/agent-os.js";
import claude from "../../registry/agent/claude/dist/index.js";
import coreutils from "../../registry/software/coreutils/dist/index.js";
import ripgrep from "../../registry/software/ripgrep/dist/index.js";

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

const tokens = loadEnvTokens();
if (!tokens.ANTHROPIC_API_KEY) {
	throw new Error("ANTHROPIC_API_KEY not found in ~/misc/env.txt");
}

const moduleAccessCwd = resolve(import.meta.dirname, "../../packages/core");
const vm = await AgentOs.create({
	moduleAccessCwd,
	software: [claude, coreutils, ripgrep],
});

let sessionId;
const permissionRequests = [];
const startedAt = Date.now();
let stage = "boot";

try {
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

	const promptText =
		"Run `xu hello-real-e2e` inside the Agent OS shell. " +
		"You must actually execute the command. " +
		"Reply with the exact stdout only and no markdown.";

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
				agentInfo: vm.getSessionAgentInfo(sessionId),
				capabilities: vm.getSessionCapabilities(sessionId),
				stopReason: response.result?.stopReason ?? null,
				assistantText,
				permissionRequestCount: permissionRequests.length,
				permissionRequests,
				toolCallCount: countUpdateKind(notifications, "tool_call"),
				toolCallUpdateCount: countUpdateKind(
					notifications,
					"tool_call_update",
				),
				messageChunkCount: countUpdateKind(
					notifications,
					"agent_message_chunk",
				),
				currentModeId: vm.getSessionModes(sessionId)?.currentModeId ?? null,
				elapsedMs: Date.now() - startedAt,
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(
		JSON.stringify(
			{
				ok: false,
				stage,
				sessionId: sessionId ?? null,
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - startedAt,
				permissionRequestCount: permissionRequests.length,
				permissionRequests,
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
