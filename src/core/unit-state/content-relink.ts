/**
 * @file content-relink.ts
 *   VS Code の外で動かされたファイルを、**内容で**行と結び直す（roadmap-v01 の P04）。
 *
 *   エディタ上の移動は `rename-follow.ts` がイベントで拾うが、git・CLI・外部エクスプローラでの
 *   移動はイベントが来ないので素通りする。そのとき external では次の形になる。
 *
 *   ```
 *   ja/guide.md → ja/handbook.md   （原文も訳文も外で動かされた）
 *   en/guide.md → en/handbook.md
 *
 *   unit-state:  en/guide.md の行が残っているが、ファイルはもう無い
 *   ディスク:    en/handbook.md はあるが、行が1つも無い
 *   ```
 *
 *   このまま sync すると、`en/handbook.md` の全ユニットが「新規」と判定されて `need:translate`
 *   になり、**人の訳が次の翻訳で潰される**。旧パスの行は掃除で消える。
 *
 *   手がかりは行が覚えている**本文の hash** である。移動しただけならファイルの中身は
 *   1バイトも変わっていないので、旧行の hash 集合といまの本文の hash 集合が一致する。
 *   似ぐあいを測る必要はなく、集合の重なりだけで決まる。
 *
 *   **迷ったら結び直さない。** 結び直しを見送っても、いまと同じ（状態が失われ、孤立として
 *   画面に出る）だけで新しい壊れ方は増えない。逆に誤って結ぶと、別の文書の翻訳状態が
 *   その文書に付き、`need:revise@無関係な章` が生まれて取り返しがつかない。この非対称に
 *   合わせて、**双方向に候補が1つずつのときだけ**移送する（ADR-260810-01）。
 *
 * @module core/unit-state/content-relink
 */

import { Logger } from "../../infra/logging/logger";

const logger = Logger.getInstance();

/**
 * 結び直しを認める最低の被覆率（両方向とも）。
 *
 * 移動しただけなら 1.0 になる。1.0 未満になるのは「動かしたついでに直した」場合で、
 * どこまで許すかは**見送りの代償と誤りの代償の差**で決める。見送りはいまと同じ結果に
 * しかならず、誤ると別文書の状態が付く。だから高いほうに置く。
 */
export const RELINK_MIN_COVERAGE = 0.7;

/** 行を失ったパス（行はあるが、ファイルがもう無い） */
export interface LostPathCandidate {
	/** ワークスペース相対パス */
	readonly path: string;
	/** その行が覚えている本文 hash の集合（空 hash は含めない） */
	readonly hashes: ReadonlySet<string>;
}

/** 行を持たない訳文（ファイルはあるが、行が1つも無い） */
export interface NewTargetCandidate {
	/** ワークスペース相対パス */
	readonly path: string;
	/** いまの本文から計算したユニットの hash 集合 */
	readonly hashes: ReadonlySet<string>;
}

/** 結び直し1件 */
export interface RelinkDecision {
	/** 移送元（行の現在のパス） */
	readonly from: string;
	/** 移送先（ファイルが実在するパス） */
	readonly to: string;
	/** 一致したユニット数 */
	readonly matched: number;
	/** 旧行のうち、いまの本文に残っている割合 */
	readonly coverageLost: number;
	/** いまの本文のうち、旧行で説明できる割合 */
	readonly coverageNew: number;
}

/** 候補にはなったが、結び直しを見送った理由（ログにだけ出す） */
export interface RelinkRejection {
	readonly from: string;
	readonly to: string;
	readonly reason: "ambiguous-lost" | "ambiguous-new";
	readonly coverageLost: number;
	readonly coverageNew: number;
}

export interface RelinkPlan {
	readonly decisions: readonly RelinkDecision[];
	readonly rejections: readonly RelinkRejection[];
}

/**
 * 行を失ったパスと、行を持たない訳文を突き合わせて、移送する組を決める。
 *
 * 候補の絞り込みは呼び出し側の責務である（同じ TransPair の訳文ディレクトリ配下だけを
 * 渡すこと）。**未翻訳の訳文は原文の丸写しなので、原文側を混ぜると原文の行が旧訳文へ
 * 吸い込まれる。** ここに渡ってくるのは訳文だけ、という前提で書いてある。
 *
 * @param lost 行はあるがファイルが無いパス
 * @param fresh ファイルはあるが行が無い訳文
 */
export function planContentRelink(
	lost: readonly LostPathCandidate[],
	fresh: readonly NewTargetCandidate[],
): RelinkPlan {
	const decisions: RelinkDecision[] = [];
	const rejections: RelinkRejection[] = [];
	if (lost.length === 0 || fresh.length === 0) {
		return { decisions, rejections };
	}

	// 閾値を越えた組をすべて挙げる。空のファイル（hash が1つも無い）は、
	// 重なりが定義できないので初めから候補にしない
	type Pairing = { lostIdx: number; freshIdx: number; matched: number; covLost: number; covNew: number };
	const pairings: Pairing[] = [];
	for (let l = 0; l < lost.length; l++) {
		if (lost[l].hashes.size === 0) {
			continue;
		}
		for (let f = 0; f < fresh.length; f++) {
			if (fresh[f].hashes.size === 0) {
				continue;
			}
			let matched = 0;
			for (const hash of lost[l].hashes) {
				if (fresh[f].hashes.has(hash)) {
					matched++;
				}
			}
			if (matched === 0) {
				continue;
			}
			const covLost = matched / lost[l].hashes.size;
			const covNew = matched / fresh[f].hashes.size;
			if (covLost < RELINK_MIN_COVERAGE || covNew < RELINK_MIN_COVERAGE) {
				continue;
			}
			pairings.push({ lostIdx: l, freshIdx: f, matched, covLost, covNew });
		}
	}

	// **双方向に1つずつのときだけ採る。** 片側から見て候補が2つ以上あるなら、
	// どちらが正しいかを決める材料がこちらに無いということなので、結び直さない。
	// 使い回しの定型文書（同じ内容の index.md が何枚もある等）はここで落ちる
	const countByLost = new Map<number, number>();
	const countByFresh = new Map<number, number>();
	for (const p of pairings) {
		countByLost.set(p.lostIdx, (countByLost.get(p.lostIdx) ?? 0) + 1);
		countByFresh.set(p.freshIdx, (countByFresh.get(p.freshIdx) ?? 0) + 1);
	}
	for (const p of pairings) {
		const lostCount = countByLost.get(p.lostIdx) ?? 0;
		const freshCount = countByFresh.get(p.freshIdx) ?? 0;
		if (lostCount === 1 && freshCount === 1) {
			decisions.push({
				from: lost[p.lostIdx].path,
				to: fresh[p.freshIdx].path,
				matched: p.matched,
				coverageLost: p.covLost,
				coverageNew: p.covNew,
			});
			continue;
		}
		rejections.push({
			from: lost[p.lostIdx].path,
			to: fresh[p.freshIdx].path,
			reason: lostCount > 1 ? "ambiguous-lost" : "ambiguous-new",
			coverageLost: p.covLost,
			coverageNew: p.covNew,
		});
	}
	return { decisions, rejections };
}

/**
 * 決めた結果と見送った理由をログに出す。
 *
 * **数字はログにしか出さない。** ツリーにもレポートにも出さないのは、結び直しが
 * 「起きたことに人が気づいて対処する」たぐいの出来事ではないからである。成功すれば
 * 何も起きなかったのと同じ状態になり、見送れば孤立としてもう画面に出ている（P01）。
 */
export function logRelinkPlan(plan: RelinkPlan): void {
	for (const d of plan.decisions) {
		logger.info("sync", "Relinked unit-state entries to a file moved outside the editor", {
			from: d.from,
			to: d.to,
			matchedUnits: d.matched,
			coverageLost: Number(d.coverageLost.toFixed(3)),
			coverageNew: Number(d.coverageNew.toFixed(3)),
		});
	}
	for (const r of plan.rejections) {
		logger.info("sync", "Skipped relinking: more than one candidate", {
			from: r.from,
			to: r.to,
			reason: r.reason,
			coverageLost: Number(r.coverageLost.toFixed(3)),
			coverageNew: Number(r.coverageNew.toFixed(3)),
		});
	}
}
