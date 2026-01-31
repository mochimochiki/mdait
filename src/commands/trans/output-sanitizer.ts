/**
 * @file output-sanitizer.ts
 * @description 翻訳結果テキスト内のJSON残存を検出・警告するモジュール
 *
 * バリデーションを通過した後でも、最終出力テキストにJSON構造が
 * 残っている可能性を検出し、警告を生成する。
 */

/**
 * サニタイズ結果
 */
export interface SanitizeResult {
	/** 処理後テキスト */
	text: string;
	/** 検出された警告 */
	warnings: string[];
	/** JSON検出フラグ */
	jsonDetected: boolean;
	/** 検出されたパターン詳細 */
	detectedPatterns: DetectedPattern[];
}

/**
 * 検出パターン詳細
 */
export interface DetectedPattern {
	/** パターン種別 */
	type: JsonPatternType;
	/** マッチした文字列（先頭50文字まで） */
	sample: string;
	/** 出現位置（開始インデックス） */
	position: number;
}

/**
 * JSONパターン種別
 */
export type JsonPatternType =
	| "FULL_JSON_OBJECT" // {"key": "value"} 形式
	| "TRANSLATION_WRAPPER" // {"translation": ...} 形式
	| "ESCAPED_JSON" // エスケープされたJSON
	| "NESTED_BRACES"; // 連続するネストブレース

/**
 * JSON検出パターン定義
 * 優先度順に評価
 */
const JSON_DETECTION_PATTERNS: Array<{
	type: JsonPatternType;
	pattern: RegExp;
	description: string;
}> = [
	{
		// パターン1: {"translation": "..."} ラッパー検出
		// 最も致命的なパターン - AIが応答形式自体を出力してしまった場合
		type: "TRANSLATION_WRAPPER",
		pattern: /\{\s*"(?:translation|targetPatch)"\s*:\s*"/g,
		description: "AI response wrapper structure detected",
	},
	{
		// パターン2: 完全なJSONオブジェクト検出
		// 行頭から始まり、key-valueペアを含むJSONオブジェクト
		type: "FULL_JSON_OBJECT",
		pattern: /^\s*\{[^}]*"[^"]+"\s*:\s*(?:"[^"]*"|[\d.]+|true|false|null|\[|\{)/gm,
		description: "JSON object structure detected",
	},
	{
		// パターン3: エスケープされたJSON
		// \"key\": \"value\" のようなエスケープシーケンス
		type: "ESCAPED_JSON",
		pattern: /\\"\w+\\":\s*\\"/g,
		description: "Escaped JSON structure detected",
	},
	{
		// パターン4: 深くネストされたブレース
		// 3レベル以上のネスト {{{}}} は通常のテキストでは稀
		type: "NESTED_BRACES",
		pattern: /\{\s*\{\s*\{/g,
		description: "Deeply nested braces detected",
	},
];

/**
 * コードブロック範囲情報
 */
interface CodeBlockRange {
	start: number;
	end: number;
}

/**
 * コードブロック範囲を抽出
 * @param text 対象テキスト
 * @returns コードブロックの範囲配列
 */
function extractCodeBlockRanges(text: string): CodeBlockRange[] {
	const ranges: CodeBlockRange[] = [];
	const regex = /```[\s\S]*?```/g;
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional regex exec loop
	while ((match = regex.exec(text)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}

	return ranges;
}

/**
 * 位置がコードブロック内かチェック
 * @param position 検査位置
 * @param ranges コードブロック範囲配列
 * @returns コードブロック内の場合true
 */
function isWithinCodeBlock(position: number, ranges: CodeBlockRange[]): boolean {
	return ranges.some((r) => position >= r.start && position < r.end);
}

/**
 * 翻訳出力をサニタイズ
 * @param text 翻訳結果テキスト
 * @returns サニタイズ結果
 */
export function sanitizeTranslationOutput(text: string): SanitizeResult {
	const detectedPatterns: DetectedPattern[] = [];
	const warnings: string[] = [];

	// コードブロック内のJSONは除外対象として抽出
	const codeBlockRanges = extractCodeBlockRanges(text);

	for (const patternDef of JSON_DETECTION_PATTERNS) {
		// 新しいRegExpインスタンスを作成してlastIndexをリセット
		const regex = new RegExp(patternDef.pattern.source, patternDef.pattern.flags);
		let match: RegExpExecArray | null;

		// biome-ignore lint/suspicious/noAssignInExpressions: intentional regex exec loop
		while ((match = regex.exec(text)) !== null) {
			// コードブロック内のマッチは除外
			if (isWithinCodeBlock(match.index, codeBlockRanges)) {
				continue;
			}

			detectedPatterns.push({
				type: patternDef.type,
				sample: match[0].substring(0, 50),
				position: match.index,
			});

			warnings.push(`[JSON混入警告] ${patternDef.description} at position ${match.index}`);
		}
	}

	return {
		text, // 現バージョンではテキスト変更なし（警告のみ）
		warnings,
		jsonDetected: detectedPatterns.length > 0,
		detectedPatterns,
	};
}
