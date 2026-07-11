/**
 * mdait.json 設定エディタのモデル生成。
 * JSON スキーマ（assets/schemas/mdait-config.schema.json）を唯一の真実源として、
 * 設定画面に表示するディスクリプタ一覧を生成する。
 * VS Code API 非依存の純粋ロジック（単体テスト対象）。
 */

/** JSON スキーマの必要最小限の型（draft-07 のうち mdait スキーマで使う範囲） */
export interface JsonSchemaNode {
	type?: string | string[];
	description?: string;
	default?: unknown;
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	pattern?: string;
	format?: string;
	examples?: unknown[];
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	items?: JsonSchemaNode;
	oneOf?: JsonSchemaNode[];
	additionalProperties?: boolean | JsonSchemaNode;
	minItems?: number;
}

/**
 * 設定ウィジェットの種別。
 * - unsupported: 生成器が対応しない形（oneOf 複合型など）。UI では「JSONで編集」フォールバック表示にする
 */
export type SettingWidgetType =
	| "boolean"
	| "integer"
	| "number"
	| "string"
	| "enum"
	| "stringArray"
	| "objectArray"
	| "unsupported";

/** objectArray（transPairs 等）の表エディタ列定義 */
export interface ObjectArrayField {
	key: string;
	description: string;
	required: boolean;
	pattern?: string;
	examples?: unknown[];
}

/** 1 つの設定項目のディスクリプタ */
export interface SettingDescriptor {
	/** ドット結合 ID（例: "ai.ollama.endpoint"）。表示・検索・webview との対話に使用 */
	id: string;
	/** JSON 上の実キーパス（prompts の "trans.translate" のようなドット入りキーを保持するため配列） */
	path: string[];
	/** 所属カテゴリ（スキーマのトップレベルキー。スカラーは "general"） */
	category: string;
	type: SettingWidgetType;
	/** スキーマ由来の説明（英語）。UI 側で l10n 解説が無い場合のフォールバック */
	description: string;
	default?: unknown;
	enum?: string[];
	minimum?: number;
	maximum?: number;
	pattern?: string;
	examples?: unknown[];
	/** スキーマ required 由来（transPairs / primaryLang） */
	required: boolean;
	/** objectArray の場合の列定義（文字列型プロパティのみ。それ以外は JSON 編集に委ねる） */
	itemFields?: ObjectArrayField[];
}

/** カテゴリ単位でまとめた設定モデル */
export interface SettingsCategory {
	id: string;
	settings: SettingDescriptor[];
}

/** カテゴリの表示順。スカラー設定は general に集約し、未知のトップレベルキーは末尾に追加する */
const CATEGORY_ORDER = [
	"general",
	"sync",
	"markers",
	"ai",
	"trans",
	"terms",
	"tm",
	"aiSync",
	"prompts",
];

/** UI に出さないトップレベルキー */
const EXCLUDED_TOP_LEVEL_KEYS = new Set(["$schema"]);

/**
 * JSON スキーマから設定画面モデルを生成する。
 * トップレベルの object プロパティはカテゴリになり、その配下のリーフが設定項目になる。
 * トップレベルのスカラー/配列プロパティは "general" カテゴリに集約する。
 */
export function buildSettingsModel(schema: JsonSchemaNode): SettingsCategory[] {
	const properties = schema.properties ?? {};
	const requiredTopLevel = new Set(schema.required ?? []);
	const byCategory = new Map<string, SettingDescriptor[]>();

	const add = (descriptor: SettingDescriptor): void => {
		const list = byCategory.get(descriptor.category) ?? [];
		list.push(descriptor);
		byCategory.set(descriptor.category, list);
	};

	for (const [key, node] of Object.entries(properties)) {
		if (EXCLUDED_TOP_LEVEL_KEYS.has(key)) {
			continue;
		}
		if (isCategoryObject(node)) {
			// object 型トップレベルキー: 配下を再帰的にリーフへ展開
			collectLeaves(node, [key], key, add);
		} else {
			add(toDescriptor(key, node, [key], "general", requiredTopLevel.has(key)));
		}
	}

	const orderedIds = [
		...CATEGORY_ORDER.filter((id) => byCategory.has(id)),
		...[...byCategory.keys()].filter((id) => !CATEGORY_ORDER.includes(id)),
	];
	return orderedIds.map((id) => ({
		id,
		settings: byCategory.get(id) ?? [],
	}));
}

/** サブオブジェクトを持つ「カテゴリ」ノードか（properties を持つ object 型） */
function isCategoryObject(node: JsonSchemaNode): boolean {
	return node.type === "object" && node.properties !== undefined;
}

/** object ノード配下のリーフ設定を再帰的に収集する */
function collectLeaves(
	node: JsonSchemaNode,
	path: string[],
	category: string,
	add: (descriptor: SettingDescriptor) => void,
): void {
	const required = new Set(node.required ?? []);
	for (const [key, child] of Object.entries(node.properties ?? {})) {
		const childPath = [...path, key];
		if (isCategoryObject(child)) {
			collectLeaves(child, childPath, category, add);
		} else {
			add(
				toDescriptor(
					childPath.join("."),
					child,
					childPath,
					category,
					required.has(key),
				),
			);
		}
	}
}

/** スキーマノードをディスクリプタに変換する */
function toDescriptor(
	id: string,
	node: JsonSchemaNode,
	path: string[],
	category: string,
	required: boolean,
): SettingDescriptor {
	const base: SettingDescriptor = {
		id,
		path,
		category,
		type: resolveWidgetType(node),
		description: node.description ?? resolveOneOfDescription(node),
		default: node.default,
		minimum: node.minimum,
		maximum: node.maximum,
		pattern: node.pattern,
		examples: node.examples,
		required,
	};
	if (node.enum) {
		base.enum = node.enum.map((value) => String(value));
	}
	if (base.type === "objectArray" && node.items?.properties) {
		base.itemFields = buildItemFields(node.items);
	}
	return base;
}

/** oneOf しか description を持たないノード（ignoredPatterns 等）から説明を補完する */
function resolveOneOfDescription(node: JsonSchemaNode): string {
	for (const variant of node.oneOf ?? []) {
		if (variant.description) {
			return variant.description;
		}
	}
	return "";
}

/** ノードの形からウィジェット種別を決定する */
function resolveWidgetType(node: JsonSchemaNode): SettingWidgetType {
	if (node.enum) {
		return "enum";
	}
	if (node.oneOf) {
		// string | string[] の oneOf（ignoredPatterns）は配列エディタに寄せる。
		// それ以外の複合 oneOf（copyAssets 等）は JSON 編集フォールバック
		const types = node.oneOf.map((variant) => variant.type);
		if (
			types.length === 2 &&
			types.includes("string") &&
			node.oneOf.some(
				(variant) => variant.type === "array" && variant.items?.type === "string",
			)
		) {
			return "stringArray";
		}
		return "unsupported";
	}
	const type = Array.isArray(node.type)
		? // ["string","number"]（keepAlive）は自由入力の文字列として扱う
			node.type.includes("string")
			? "string"
			: node.type[0]
		: node.type;
	switch (type) {
		case "boolean":
			return "boolean";
		case "integer":
			return "integer";
		case "number":
			return "number";
		case "string":
			return "string";
		case "array":
			if (node.items?.type === "string") {
				return "stringArray";
			}
			if (node.items?.type === "object") {
				return "objectArray";
			}
			return "unsupported";
		default:
			return "unsupported";
	}
}

/**
 * objectArray（transPairs）の表エディタ列を生成する。
 * 文字列型プロパティのみ列にする。それ以外（copyAssets の oneOf 等）は
 * 表を複雑化させないため列にせず、mdait.json での直接編集に委ねる。
 */
function buildItemFields(items: JsonSchemaNode): ObjectArrayField[] {
	const required = new Set(items.required ?? []);
	const fields: ObjectArrayField[] = [];
	for (const [key, child] of Object.entries(items.properties ?? {})) {
		if (child.type !== "string") {
			continue;
		}
		fields.push({
			key,
			description: child.description ?? "",
			required: required.has(key),
			pattern: child.pattern,
			examples: child.examples,
		});
	}
	return fields;
}
