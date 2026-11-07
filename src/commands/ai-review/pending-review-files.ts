/**
 * @file pending-review-files.ts
 * @description
 *   「レビュー待ち（need:review）を AI で一括消化する」入口が対象にするファイルの選別。
 *   ステータスツリーのファイル項目から、AI レビューにかける訳文ファイルの集合と
 *   これから見に行くユニットの数を決める（渡された項目を読むだけで、何も書き換えない）。
 *
 *   need:review は本文ユニットのほかに次の2か所にも載る:
 *   - frontmatter（タイトルなど）: `FileStatusItem.frontmatter.needFlag`。
 *     取り込み（adopt）は frontmatter にも need:review を付け、AI レビューも
 *     `collectFrontmatterReviewPair` で対にする（ADR-260902-02）
 *   - 非Markdown（`trans.extensions`）: ファイル＝1ユニットで children を持たず、
 *     need は `FileStatusItem.needFlag` に載る（`plain-file-handler.ts`）
 *   本文だけを拾うと、AI が本文を片づけたあとに frontmatter と .txt/.csv/.json の
 *   確認待ちだけが残り、「一括で片づける」が最後の数件で途切れる。
 *
 *   1ファイルの中をどう歩くか（どこに載る need を見るか・孤立訳文と原文側を外すこと）は、
 *   ツリーの要対応と同じ `attentionItemsInFile` を通す。ここで決めるのは「review だけを
 *   拾う」ことと、ファイル単位にまとめて並べることだけである。
 * @module commands/ai-review/pending-review-files
 */

import { type AttentionFileLike, attentionItemsInFile } from "../../core/status/status-item-tree";

/** 選別に要るファイル項目の形だけ（`FileStatusItem` の部分型。テストで組み立てやすくする） */
export interface PendingReviewFileLike extends AttentionFileLike {
	filePath: string;
	/** 本文ユニットの need */
	children?: { needFlag?: string }[];
}

/** レビュー待ちの対象ファイルと、その中のレビュー待ちユニット数 */
export interface PendingReviewCollection {
	/** AI レビューにかける訳文ファイルの絶対パス。重複なし・パス昇順 */
	files: string[];
	/** need:review のユニット数（本文＋frontmatter＋非Markdown ファイルの合計） */
	units: number;
}

/**
 * need:review を1つでも含むファイルを重複なく集め、レビュー待ちユニットを数える。
 *
 * verify-deletion は拾わない — あれは「消してよいか」の人の判断待ちで、
 * 訳の忠実さを AI に確かめさせても答えにならない（`collectReviewPairs` も対象にしない）。
 *
 * 並びはファイルパス昇順に固定する。ツリーの走査順（スキャン順）に任せると、
 * 同じ状態でも起動ごとに進捗の順が変わって見え、レポートの並びも揺れる。
 * ロケール依存の比較は使わない（`compareNeedsAttentionItems` と同じ理由）。
 */
export function collectPendingReviewFiles(files: readonly PendingReviewFileLike[]): PendingReviewCollection {
	const paths = new Set<string>();
	let units = 0;
	for (const file of files) {
		// 原文の無い訳文（孤立）と原文側のファイルは、review が残っていても対にできないので
		// `attentionItemsInFile` が歩かない（走らせると「原文が見つからない」のエラーになる。
		// `review-targets.ts` が同じ理由で外している）
		let count = 0;
		for (const item of attentionItemsInFile(file, file.children ?? [])) {
			if (item.needFlag === "review") {
				count++;
			}
		}
		if (count === 0) {
			continue;
		}
		// 同じパスの項目が二度渡っても、走らせるのも数えるのも一度だけ
		// （ツリーは1パス1項目だが、ここは呼び出し元の作りに依存しない）
		if (paths.has(file.filePath)) {
			continue;
		}
		paths.add(file.filePath);
		units += count;
	}
	return {
		files: Array.from(paths).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
		units,
	};
}
