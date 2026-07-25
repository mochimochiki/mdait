/**
 * @file response-language.ts
 * @description
 *   AI が返す自然文（レビューの reason / issues など）の記述言語を決める小さなヘルパー。
 *   VS Code の表示言語（`vscode.env.language`）＝ユーザーが今使っている言語に合わせる
 *   （ADR-260719-01: レポート/レビューの表示言語化）。プロンプトへは `{{responseLang}}` として渡す。
 * @module infra/llm/response-language
 */
import * as vscode from "vscode";

/**
 * VS Code の表示言語コード → 英語表記の言語名。
 * VS Code が提供する表示言語（Language Pack）を網羅する。未知のコードはコードのまま使う。
 */
const LANGUAGE_NAMES: Record<string, string> = {
	en: "English",
	ja: "Japanese",
	"zh-cn": "Simplified Chinese",
	"zh-tw": "Traditional Chinese",
	ko: "Korean",
	fr: "French",
	de: "German",
	es: "Spanish",
	it: "Italian",
	ru: "Russian",
	"pt-br": "Brazilian Portuguese",
	tr: "Turkish",
	pl: "Polish",
	cs: "Czech",
	hu: "Hungarian",
	bg: "Bulgarian",
};

/**
 * VS Code の表示言語コードを返す（例: "ja"・"pt-br"）。取得できない場合は "en"。
 */
export function getDisplayLanguageCode(): string {
	const language = vscode.env?.language;
	if (typeof language !== "string" || language.trim() === "") {
		return "en";
	}
	return language.toLowerCase();
}

/**
 * プロンプトの `{{responseLang}}` に渡す言語指定文字列を返す。
 * 例: "Japanese (ja)"・未知コードは "pt-pt" のようにコードのみ。
 *
 * @param code 言語コード（省略時は VS Code の表示言語）
 */
export function getResponseLanguage(code: string = getDisplayLanguageCode()): string {
	const normalized = code.toLowerCase();
	const name = LANGUAGE_NAMES[normalized] ?? LANGUAGE_NAMES[normalized.split("-")[0]];
	return name ? `${name} (${normalized})` : normalized;
}
