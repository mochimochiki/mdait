/**
 * @file output-strategy.ts
 * @description 翻訳結果の出力戦略インターフェース
 * Phase 1: AppendBelowStrategy（選択範囲の下に追記）
 * Phase 2以降: ClipboardStrategy、NewTabStrategyなど
 */

import type * as vscode from "vscode";

/**
 * 翻訳結果データ
 */
export interface TranslationOutput {
	/** 原文テキスト */
	sourceText: string;
	/** 翻訳結果テキスト */
	translatedText: string;
	/** 原文言語 */
	sourceLang: string;
	/** 翻訳先言語 */
	targetLang: string;
}

/**
 * 翻訳結果の出力戦略インターフェース
 * 出力先（エディタ追記、クリップボード、新規タブなど）を抽象化
 */
export interface OutputStrategy {
	/** 戦略名（識別用） */
	readonly name: string;

	/**
	 * 翻訳結果を適用
	 * @param output 翻訳結果データ
	 * @param editor エディタインスタンス
	 */
	apply(output: TranslationOutput, editor: vscode.TextEditor): Promise<void>;
}
