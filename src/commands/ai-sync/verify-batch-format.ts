/**
 * @file verify-batch-format.ts
 * @description
 *   AIペアリング検証のバッチ整形純関数群。ペア配列の分割と、バッチプロンプトに埋め込む
 *   <pair> ブロック列の組み立てを行う。VS Code API 非依存。
 * @module commands/ai-sync/verify-batch-format
 */

/** バッチ検証の1ペア分の入力 */
export interface VerifyBatchPair {
	/** バッチ内 1-based インデックス（応答の対応付けに使う） */
	index: number;
	sourceText: string;
	targetText: string;
	/** ユニットに紐づく人間の note（意図的な乖離の説明など） */
	humanNote?: string;
	/** 用語集 JSON（termsToJson の出力。該当なしなら undefined） */
	termsJson?: string;
	/** TM参照（formatTmReferences の出力。該当なしなら undefined） */
	tmReferences?: string;
	/** ログ用コンテキスト */
	unitContext?: { unitHash?: string; title?: string };
}

/** 山括弧をエスケープしてテキストをラッパータグ内の「データ」に閉じ込める */
export function escapeForTag(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 配列を size 件ずつのバッチに分割する（最終バッチは端数可）。
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const safeSize = Math.max(1, Math.floor(size));
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += safeSize) {
		batches.push(items.slice(i, i + safeSize));
	}
	return batches;
}

/**
 * バッチプロンプトの {{pairs}} に渡す <pair> ブロック列を組み立てる。
 *
 * - unit 本文は単ペア版の <sourceUnit>/<targetUnit> と同様エスケープしない
 *   （Markdown をそのまま見せる。境界崩れは index echo 検証で検出される）
 * - humanNote / terms / tmReferences は外部データ（note・terms.csv・TMX 由来）なので
 *   エスケープして「データ」として閉じ込め、タグブレイクによる境界崩れを防ぐ
 * - humanNote / terms / tmReferences は存在時のみタグを出力する
 */
export function buildPairsBlock(pairs: readonly VerifyBatchPair[]): string {
	return pairs
		.map((pair) => {
			const blocks: string[] = [
				`<sourceUnit>\n${pair.sourceText}\n</sourceUnit>`,
				`<targetUnit>\n${pair.targetText}\n</targetUnit>`,
			];
			if (pair.humanNote?.trim()) {
				blocks.push(`<humanNote>\n${escapeForTag(pair.humanNote.trim())}\n</humanNote>`);
			}
			if (pair.termsJson?.trim()) {
				blocks.push(`<terms>\n${escapeForTag(pair.termsJson.trim())}\n</terms>`);
			}
			if (pair.tmReferences?.trim()) {
				blocks.push(`<tmReferences>\n${escapeForTag(pair.tmReferences.trim())}\n</tmReferences>`);
			}
			return `<pair index="${pair.index}">\n${blocks.join("\n")}\n</pair>`;
		})
		.join("\n\n");
}
