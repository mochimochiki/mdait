/**
 * @file term-lint.ts
 * @description
 *   用語一貫性検証（term-lint）の純関数。AIを使わない機械照合で、
 *   翻訳済みペアユニットの訳文が用語集の期待訳語を使っているかを検証する。
 *
 *   保守的な閾値: 「原文に用語（正規形＋variants）が出現し、かつ訳文に期待訳語
 *   （正規形＋variants）が全く出現しない」場合のみ違反とする。
 *   偽陽性が多い検証はエージェントに無視されるため、疑わしきは違反としない。
 *
 *   違反は警告であり自動修正しない。対処（reviseする / variantsに追加する）の
 *   選択はエージェント/人間に委ねる（docs/design/agent-orchestration.md 参照）。
 *   VS Code API 非依存・単体テスト可能。
 * @module core/term/term-lint
 */
import { anyTermVariantAppears, stripCodeSegments } from "./term-matcher";

/** term-lint に渡す用語（用語集エントリの言語ペア投影） */
export interface TermLintTerm {
	/** 原文言語の正規形 */
	source: string;
	/** 原文言語の表記揺れ */
	sourceVariants: readonly string[];
	/** 期待する訳語（訳文言語の正規形） */
	expected: string;
	/** 訳語の表記揺れ */
	expectedVariants: readonly string[];
}

/** term-lint の違反 */
export interface TermLintViolation {
	/** 原文に出現した用語 */
	term: string;
	/** 期待していた訳語（正規形） */
	expected: string;
	/** 許容される訳語（正規形＋variants） */
	expectedVariants: readonly string[];
}

/**
 * 翻訳済みペアユニット1件に対する用語一貫性検証。
 * コードブロック・インラインコード内の出現は照合対象から除外する。
 *
 * @param sourceContent 原文ユニット本文
 * @param targetContent 訳文ユニット本文
 * @param terms 検証する用語（原文言語→訳文言語）
 * @returns 違反一覧（違反なしなら空配列）
 */
export function lintUnitPair(
	sourceContent: string,
	targetContent: string,
	terms: readonly TermLintTerm[],
): TermLintViolation[] {
	if (terms.length === 0) {
		return [];
	}

	const strippedSource = stripCodeSegments(sourceContent);
	const strippedTarget = stripCodeSegments(targetContent);
	const violations: TermLintViolation[] = [];

	for (const term of terms) {
		if (!term.source || !term.expected) {
			continue;
		}
		// 原文に用語が出現しなければ対象外
		if (!anyTermVariantAppears(strippedSource, term.source, term.sourceVariants)) {
			continue;
		}
		// 訳文に期待訳語（正規形＋variants）のいずれかが出現すればOK
		if (anyTermVariantAppears(strippedTarget, term.expected, term.expectedVariants)) {
			continue;
		}
		violations.push({
			term: term.source,
			expected: term.expected,
			expectedVariants: [term.expected, ...term.expectedVariants],
		});
	}

	return violations;
}
