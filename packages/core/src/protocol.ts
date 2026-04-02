// JSON-RPC 2.0 types and helpers for ACP communication

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number | string | null;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export function serializeMessage(
	msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification,
): string {
	return `${JSON.stringify(msg)}\n`;
}

export function deserializeMessage(
	line: string,
): JsonRpcRequest | JsonRpcResponse | JsonRpcNotification | null {
	try {
		const parsed = JSON.parse(line);
		if (parsed?.jsonrpc !== "2.0") return null;
		return parsed;
	} catch {
		return null;
	}
}

export function isResponse(
	msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification,
): msg is JsonRpcResponse {
	return "id" in msg && !("method" in msg);
}

export function isRequest(
	msg: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification,
): msg is JsonRpcRequest {
	return "id" in msg && "method" in msg;
}
