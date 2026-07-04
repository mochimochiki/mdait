/**
 * @file backfill.ts
 * @description
 *   逆方向埋め戻し（backfill）のペア解決とマーカー相互更新。
 *   sync（orphanTargetPolicy: "backfill"）が原文側に生成した need:backfill プレースホルダに対し、
 *   trans が訳文ユニット本文を言語逆転で翻訳して埋め戻す際の、AI 呼び出しを除く純粋なロジック。
 *   （docs/design/agent-orchestration.md M5 参照）
 * @module commands/trans/backfill
 */
import { calculateHash } from "../../core/hash/hash-calculator";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";

/** backfill対象のペア（原文プレースホルダとその内容元の訳文ユニット） */
export interface BackfillPair {
	/** 原文側プレースホルダユニット（need:backfill） */
	source: MdaitUnit;
	/** 内容元の訳文ユニット（from = source.hash） */
	target: MdaitUnit;
}

/**
 * ソースユニット群から need:backfill ユニットを検出し、
 * from 参照（target.from === source.hash）で訳文ユニットと対応付ける。
 * 対応する訳文ユニットが見つからないプレースホルダは結果に含めない。
 */
export function collectBackfillPairs(
	sourceUnits: readonly MdaitUnit[],
	targetUnits: readonly MdaitUnit[],
): BackfillPair[] {
	const pairs: BackfillPair[] = [];
	for (const source of sourceUnits) {
		if (source.marker?.need !== "backfill" || !source.marker.hash) {
			continue;
		}
		const target = targetUnits.find((t) => t.marker?.from === source.marker.hash);
		if (target?.marker) {
			pairs.push({ source, target });
		}
	}
	return pairs;
}

/**
 * 逆方向翻訳の結果をペアに適用する。
 * - 原文側: 本文を翻訳結果に置換、ハッシュ再計算、need:review を残す
 *   （逆生成された原文の品質確認を人間/エージェントに委ねる）
 * - 訳文側: from を新しい原文ハッシュに更新（通常の from リンクの確立）
 *
 * 適用後の状態は次の sync で無変更（冪等な定常状態）になる。
 */
export function applyBackfillTranslation(pair: BackfillPair, translatedText: string): void {
	pair.source.content = translatedText;
	const newHash = calculateHash(translatedText);
	pair.source.marker.hash = newHash;
	pair.source.marker.setNeed("review");
	pair.target.marker.from = newHash;
}
