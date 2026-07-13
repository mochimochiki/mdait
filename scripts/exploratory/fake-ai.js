"use strict";
/*
 * 構造化フェイク AIService。
 *
 * trans パイプラインが要求する JSON エンベロープ {"translation": "..."} を決定的に返す。
 * 素の `default`（DefaultAIProvider）はプレーンテキストを返し検証に落ちるため、機構（正常系）の
 * 決定的検証には使えない。ここでは AIServiceBuilder.prototype.build を差し替えて全 AI 経路へ注入する。
 *
 * 注意: revise パッチ（targetPatch 統一diff）は本フェイクでは生成せず translation 形状を返すため、
 * revise の trans 側は検証失敗→フォールバック全文翻訳に収束する。revise パッチ適用や訳質は
 * 実LLMでの確認事項（本ハーネスの対象外）。
 */
const path = require("node:path");
const { REPO } = require("./vscode-shim");

function extractSourceText(messages) {
	const last = [...messages].reverse().find((m) => m.role === "user");
	const content = Array.isArray(last && last.content) ? last.content.join("\n") : String((last && last.content) || "");
	const marker = "=== SOURCE TEXT ===";
	const idx = content.indexOf(marker);
	return (idx >= 0 ? content.slice(idx + marker.length) : content).trim();
}

const fakeAiService = {
	async sendMessage(_systemPrompt, messages) {
		const src = extractSourceText(messages);
		// 決定的・JSON混入なしのモック訳文
		const translation = `${src.replace(/\s+/g, " ").slice(0, 200)} [MT]`.replace(/[{}]/g, "");
		return JSON.stringify({ translation });
	},
};

function install() {
	const { AIServiceBuilder } = require(path.join(REPO, "out/infra/llm/ai-service-builder.js"));
	AIServiceBuilder.prototype.build = async () => fakeAiService;
}

module.exports = { install, fakeAiService };
