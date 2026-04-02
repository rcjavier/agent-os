import type { ZodType } from "zod";

const TYPE_NAME_MAP: Record<string, string> = {
	array: "ZodArray",
	boolean: "ZodBoolean",
	branded: "ZodBranded",
	catch: "ZodCatch",
	default: "ZodDefault",
	effects: "ZodEffects",
	enum: "ZodEnum",
	literal: "ZodLiteral",
	nullable: "ZodNullable",
	number: "ZodNumber",
	object: "ZodObject",
	optional: "ZodOptional",
	pipe: "ZodPipeline",
	pipeline: "ZodPipeline",
	readonly: "ZodReadonly",
	string: "ZodString",
	union: "ZodUnion",
};

const OPTIONAL_WRAPPER_TYPES = new Set(["ZodDefault", "ZodOptional"]);
const TRANSPARENT_WRAPPER_TYPES = new Set([
	...OPTIONAL_WRAPPER_TYPES,
	"ZodBranded",
	"ZodCatch",
	"ZodEffects",
	"ZodPipeline",
	"ZodReadonly",
]);

function getSchemaDef(schema: unknown): Record<string, unknown> {
	return ((schema as any)?._def ?? (schema as any)?.def ?? {}) as Record<
		string,
		unknown
	>;
}

export function getZodTypeName(schema: ZodType | null | undefined): string {
	if (!schema) return "";

	const def = getSchemaDef(schema);
	const rawType =
		(def.typeName as string | undefined) ??
		(def.type as string | undefined) ??
		((schema as any).type as string | undefined) ??
		"";

	return TYPE_NAME_MAP[rawType] ?? rawType;
}

function getInnerSchema(schema: ZodType): ZodType | null {
	const def = getSchemaDef(schema);
	return ((def.innerType ??
		def.schema ??
		def.type ??
		def.in) as ZodType | undefined) ?? null;
}

function getArrayElementSchema(schema: ZodType): ZodType | null {
	const def = getSchemaDef(schema);
	return ((def.element ?? def.type) as ZodType | undefined) ?? null;
}

function unwrapSchema(schema: ZodType): {
	schema: ZodType;
	typeName: string;
	isOptional: boolean;
} {
	let current = schema;
	let isOptional = false;

	while (true) {
		const typeName = getZodTypeName(current);
		if (!typeName) {
			return { schema: current, typeName, isOptional };
		}

		if (!TRANSPARENT_WRAPPER_TYPES.has(typeName)) {
			return { schema: current, typeName, isOptional };
		}

		if (OPTIONAL_WRAPPER_TYPES.has(typeName)) {
			isOptional = true;
		}

		const inner = getInnerSchema(current);
		if (!inner) {
			return { schema: current, typeName, isOptional };
		}

		current = inner;
	}
}

/**
 * Convert camelCase to kebab-case.
 * fullPage -> full-page
 */
export function camelToKebab(str: string): string {
	return str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export interface FieldInfo {
	camelName: string;
	typeName: string;
	isOptional: boolean;
	innerTypeName: string;
	arrayItemTypeName: string | null;
}

/**
 * Unwrap ZodOptional/ZodDefault layers to get the inner type.
 */
export function unwrapType(schema: ZodType): {
	typeName: string;
	isOptional: boolean;
} {
	const { typeName, isOptional } = unwrapSchema(schema);
	return { typeName, isOptional };
}

/**
 * Get the item type name for a ZodArray schema.
 */
function getArrayItemTypeName(schema: ZodType): string | null {
	const { schema: unwrapped, typeName } = unwrapSchema(schema);
	if (typeName === "ZodArray") {
		return getZodTypeName(getArrayElementSchema(unwrapped)) || null;
	}

	return null;
}

/**
 * Extract field info from a ZodObject schema.
 */
export function getZodObjectShape(schema: ZodType): Record<string, ZodType> {
	const { schema: unwrapped, typeName } = unwrapSchema(schema);
	if (typeName !== "ZodObject") {
		return {};
	}

	const def = getSchemaDef(unwrapped);
	const shape =
		typeof def.shape === "function"
			? (def.shape as () => Record<string, ZodType>)()
			: def.shape;

	if (!shape || typeof shape !== "object") {
		return {};
	}

	return shape as Record<string, ZodType>;
}

/**
 * Extract field info from a ZodObject schema.
 */
export function getFieldInfos(schema: ZodType): Map<string, FieldInfo> {
	const shape = getZodObjectShape(schema);
	const fields = new Map<string, FieldInfo>();

	for (const [name, fieldSchema] of Object.entries(shape)) {
		const { typeName: innerTypeName, isOptional } = unwrapType(fieldSchema);
		fields.set(name, {
			camelName: name,
			typeName: getZodTypeName(fieldSchema),
			isOptional,
			innerTypeName,
			arrayItemTypeName: getArrayItemTypeName(fieldSchema),
		});
	}

	return fields;
}

interface ParseResult {
	ok: true;
	input: Record<string, unknown>;
}

interface ParseError {
	ok: false;
	message: string;
}

/**
 * Parse argv against a zod schema to produce input JSON.
 *
 * Mapping rules:
 * - camelCase zod fields map to kebab-case flags: fullPage -> --full-page
 * - z.string(): --name value -> {name: "value"}
 * - z.number(): --limit 5 -> {limit: 5}
 * - z.boolean(): --full-page -> {fullPage: true}, --no-full-page -> {fullPage: false}
 * - z.enum(): --format json -> {format: "json"}
 * - z.array(z.string()): --tags foo --tags bar -> {tags: ["foo", "bar"]}
 * - Optional fields omitted from argv are undefined in input
 * - Unknown flags return error
 * - Missing required fields return error with field name
 */
export function parseArgv(
	schema: ZodType,
	argv: string[],
): ParseResult | ParseError {
	const fields = getFieldInfos(schema);
	if (fields.size === 0 && argv.length === 0) {
		return { ok: true, input: {} };
	}

	// Build lookup: kebab-flag-name -> FieldInfo
	const flagToField = new Map<string, FieldInfo>();
	for (const field of fields.values()) {
		flagToField.set(camelToKebab(field.camelName), field);
	}

	const input: Record<string, unknown> = {};
	let i = 0;

	while (i < argv.length) {
		const arg = argv[i];

		if (!arg.startsWith("--")) {
			return {
				ok: false,
				message: `Unexpected positional argument: "${arg}"`,
			};
		}

		const rawFlag = arg.slice(2);

		// Handle --no-<flag> for booleans
		if (rawFlag.startsWith("no-")) {
			const flagName = rawFlag.slice(3);
			const field = flagToField.get(flagName);
			if (field && field.innerTypeName === "ZodBoolean") {
				input[field.camelName] = false;
				i++;
				continue;
			}
			// Not a known boolean field, fall through to unknown flag check
			if (!flagToField.has(flagName)) {
				return { ok: false, message: `Unknown flag: --${rawFlag}` };
			}
		}

		const field = flagToField.get(rawFlag);
		if (!field) {
			return { ok: false, message: `Unknown flag: --${rawFlag}` };
		}

		const { camelName, innerTypeName, arrayItemTypeName } = field;

		if (innerTypeName === "ZodBoolean") {
			input[camelName] = true;
			i++;
			continue;
		}

		// All other types consume the next argument as value
		if (i + 1 >= argv.length) {
			return { ok: false, message: `Flag --${rawFlag} requires a value` };
		}
		const value = argv[i + 1];

		if (innerTypeName === "ZodNumber") {
			const num = Number(value);
			if (Number.isNaN(num)) {
				return {
					ok: false,
					message: `Flag --${rawFlag} expects a number, got "${value}"`,
				};
			}
			input[camelName] = num;
			i += 2;
			continue;
		}

		if (innerTypeName === "ZodArray") {
			if (!Array.isArray(input[camelName])) {
				input[camelName] = [];
			}
			const arr = input[camelName] as unknown[];
			if (arrayItemTypeName === "ZodNumber") {
				const num = Number(value);
				if (Number.isNaN(num)) {
					return {
						ok: false,
						message: `Flag --${rawFlag} expects a number value, got "${value}"`,
					};
				}
				arr.push(num);
			} else {
				arr.push(value);
			}
			i += 2;
			continue;
		}

		// ZodString, ZodEnum, and anything else that takes a string value
		input[camelName] = value;
		i += 2;
	}

	// Check for missing required fields
	for (const field of fields.values()) {
		if (!field.isOptional && !(field.camelName in input)) {
			return {
				ok: false,
				message: `Missing required flag: --${camelToKebab(field.camelName)}`,
			};
		}
	}

	return { ok: true, input };
}

/**
 * Get the description from a ZodType, unwrapping Optional/Default layers.
 */
export function getZodDescription(schema: ZodType): string | undefined {
	const desc =
		((schema as any).description as string | undefined) ??
		(getSchemaDef(schema).description as string | undefined);
	if (desc) return desc;

	const typeName = getZodTypeName(schema);
	if (TRANSPARENT_WRAPPER_TYPES.has(typeName)) {
		const inner = getInnerSchema(schema);
		if (inner) {
			return getZodDescription(inner);
		}
	}

	return undefined;
}

/**
 * Get enum values from a ZodEnum schema, unwrapping Optional/Default layers.
 */
export function getZodEnumValues(schema: ZodType): string[] | undefined {
	const { schema: unwrapped, typeName } = unwrapSchema(schema);
	if (typeName === "ZodEnum") {
		const runtimeOptions = (unwrapped as any).options;
		if (Array.isArray(runtimeOptions)) {
			return runtimeOptions.map(String);
		}

		const def = getSchemaDef(unwrapped);
		if (Array.isArray(def.values)) {
			return (def.values as unknown[]).map(String);
		}
		if (def.entries && typeof def.entries === "object") {
			return Object.values(def.entries).map(String);
		}
	}
	return undefined;
}
