/**
 * @file pair-collector.ts
 * @description
 *   AIレビューの対象ペア列挙。
 *   ターゲット側のユニットを from ハッシュでソースユニットに対応付ける純関数。
 *   VS Code API 非依存。
 *   - mode="pending": 「from あり ∧ need:review」のみ（AI翻訳レビュー・既定）
 *   - mode="audit": 「from あり ∧（need:review または need なし）」＝確定済みペアも監査対象
 *
 *   frontmatter（タイトルなど）も同じ規則で1件のペアとして列挙する。
 * @module commands/ai-review/pair-collector
 */

import type { FrontMatter } from "../../core/markdown/front-matter";
import { getFrontmatterTranslationValues, parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { MdaitUnit } from "../../core/markdown/mdait-unit";

/** レビュー対象ペアの列挙モード */
export type ReviewCollectMode = "pending" | "audit";

/** 検証対象のソース・ターゲットペア */
export interface ReviewPair {
	/** 本文ユニットか frontmatter か。frontmatter は承認時の書き戻し口が違う */
	kind: "unit" | "frontmatter";
	targetUnit: MdaitUnit;
	/** from ハッシュで解決したソースユニット。未解決の場合は null（skipped 扱い） */
	sourceUnit: MdaitUnit | null;
}

/**
 * frontmatter のペアをレポートで指す名前。
 *
 * ここは VS Code 非依存なので l10n を通さない。表示言語で訳し分けたくなったら
 * 呼び出し側（レポート生成）で置き換えること。
 */
export const FRONTMATTER_PAIR_TITLE = "front matter";

/**
 * 検証対象ペアを列挙する。
 * ソースは hash → unit の Map で解決する（順序ではなく from リンクに従う）。
 *
 * 対象条件（いずれも target.marker.from が必須）:
 * - "pending": target.marker.need === "review"（既存挙動）
 * - "audit": target.marker.need === "review" または need なし（確定済みペア）。
 *   translate / revise@ / isolate / verify-deletion 等の
 *   in-flight 状態は監査対象外（確定した対訳ではないため）。
 */
export function collectReviewPairs(
	sourceUnits: MdaitUnit[],
	targetUnits: MdaitUnit[],
	mode: ReviewCollectMode = "pending",
): ReviewPair[] {
	const sourceByHash = new Map<string, MdaitUnit>();
	for (const unit of sourceUnits) {
		if (unit.marker?.hash) {
			sourceByHash.set(unit.marker.hash, unit);
		}
	}

	const pairs: ReviewPair[] = [];
	for (const target of targetUnits) {
		const from = target.marker?.from;
		if (!from || !isReviewTarget(target.marker?.need ?? null, mode)) {
			continue;
		}
		pairs.push({
			kind: "unit",
			targetUnit: target,
			sourceUnit: sourceByHash.get(from) ?? null,
		});
	}
	return pairs;
}

/**
 * frontmatter（タイトルなど）の対を、本文ユニットと同じ形の1ペアとして組み立てる。
 *
 * **取り込み（adopt）は frontmatter にも `need:review` を付ける**（ADR-260902-02）。
 * ここを列挙しないと、AI が本文をすべて片づけたあとに frontmatter の確認待ちだけが
 * ツリーへ残り、「AI が整える」が最後の1件で途切れる。
 *
 * 判定にかけるのは翻訳対象キーの値だけで、`key: value` の行に組み直して渡す。
 * frontmatter 全体を渡すと、訳す対象でないキー（weight・date など）の差まで
 * 「訳し漏れ」として拾われる。
 *
 * @returns 対象が無ければ null（キー未設定・マーカー無し・from 無し・値が空）
 */
export function collectFrontmatterReviewPair(
	sourceFrontMatter: FrontMatter | undefined,
	targetFrontMatter: FrontMatter | undefined,
	keys: string[],
	mode: ReviewCollectMode = "pending",
): ReviewPair | null {
	if (keys.length === 0) {
		return null;
	}
	const targetMarker = parseFrontmatterMarker(targetFrontMatter);
	if (!targetMarker?.from || !isReviewTarget(targetMarker.need ?? null, mode)) {
		return null;
	}
	const targetText = renderFrontmatterText(targetFrontMatter, keys);
	if (targetText === "") {
		return null;
	}

	const sourceMarker = parseFrontmatterMarker(sourceFrontMatter);
	// 本文と同じく、対応づけは並び順ではなく from の紐で決める
	const sourceUnit =
		sourceMarker?.hash === targetMarker.from
			? new MdaitUnit(sourceMarker, FRONTMATTER_PAIR_TITLE, 0, renderFrontmatterText(sourceFrontMatter, keys), 0, 0)
			: null;

	return {
		kind: "frontmatter",
		targetUnit: new MdaitUnit(targetMarker, FRONTMATTER_PAIR_TITLE, 0, targetText, 0, 0),
		sourceUnit,
	};
}

/** 翻訳対象キーのうち値のあるものを `key: value` の行に組み直す */
function renderFrontmatterText(frontMatter: FrontMatter | undefined, keys: string[]): string {
	const values = getFrontmatterTranslationValues(frontMatter, keys);
	return keys
		.filter((key) => (values[key] ?? "").trim() !== "")
		.map((key) => `${key}: ${values[key]}`)
		.join("\n");
}

/**
 * need 値が指定モードの検証対象かを判定する。
 * audit では「need:review」に加えて「確定済み（need なし）」も対象に含める。
 */
function isReviewTarget(need: string | null, mode: ReviewCollectMode): boolean {
	if (need === "review") {
		return true;
	}
	return mode === "audit" && (need === null || need === "");
}
