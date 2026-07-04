/**
 * @file tool-result.ts
 * @description エンベロープを LanguageModelToolResult へ変換する共通ヘルパー。
 * @module lm-tools/tool-result
 */
import * as vscode from "vscode";
import { type ToolEnvelope, serializeEnvelope } from "./envelope";

/**
 * エンベロープをシリアライズして LanguageModelToolResult に包む
 */
export function toToolResult(envelope: ToolEnvelope<unknown>): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(serializeEnvelope(envelope)),
	]);
}
