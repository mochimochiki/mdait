/**
 * マーカー同期の共通ロジック
 * syncFrontmatterMarkersとupdateSectionHashesで共有される
 * 変更検出とneedフラグ設定のロジックを統一
 */

import { MdaitMarker } from "../../core/markdown/mdait-marker";

/**
 * マーカー同期のコンテキスト
 */
export interface MarkerSyncContext {
	/** 現在のソースハッシュ */
	sourceHash: string;
	/** 現在のターゲットハッシュ（ない場合はnull） */
	targetHash: string | null;
	/** 既存のターゲットマーカー（ない場合はnull） */
	existingMarker: MdaitMarker | null;
	/**
	 * 既訳の採用（adopt）モードか。**マーカーの無い訳文に中身があるとき**に真を渡す。
	 * 本文ユニット側の `adoptTarget`（`applyNeedForChangedSource`）と同じ意味で、
	 * `need:translate` の代わりに `need:review` を付けて trans の上書きから守る。
	 */
	adoptTarget?: boolean;
}

/**
 * マーカー同期の結果
 */
export interface MarkerSyncResult {
	/** 更新後のマーカー */
	marker: MdaitMarker;
	/** 変更があったかどうか */
	changed: boolean;
	/** 変更の種類 */
	changeType: "none" | "new" | "source-changed" | "target-changed";
}

/**
 * ソース側マーカーを同期する
 * - hashを計算して付与
 * - fromとneedは設定しない（ソース側なので）
 *
 * @param currentHash 現在のソースコンテンツのハッシュ
 * @param existingMarker 既存のマーカー（ない場合はnull）
 * @returns 同期結果
 */
export function syncSourceMarker(
	currentHash: string,
	existingMarker: MdaitMarker | null,
): MarkerSyncResult {
	if (!existingMarker) {
		// 新規マーカー作成
		return {
			marker: new MdaitMarker(currentHash),
			changed: true,
			changeType: "new",
		};
	}

	if (existingMarker.hash !== currentHash) {
		// ハッシュが変わった場合のみ更新
		existingMarker.hash = currentHash;
		return {
			marker: existingMarker,
			changed: true,
			changeType: "source-changed",
		};
	}

	// 変更なし
	return {
		marker: existingMarker,
		changed: false,
		changeType: "none",
	};
}

/**
 * 原文が変わった訳文の need を決める。**本文ユニットと frontmatter で唯一の実装。**
 *
 * 以前は `syncTargetMarker` と `syncMarkerPair` が同じ分岐を書き写しており、原文を戻した
 * ときの後始末が片方にしか入っていなかった。決め方を増やすときは必ずここ1か所に書く。
 *
 * @param marker 更新するターゲット側マーカー（`from` は更新済みであること）
 * @param oldSourceHash 更新前の `from`（＝この訳文が対応していた原文のハッシュ）
 * @param adoptTarget 既訳の採用モードか
 */
function applyNeedForChangedSource(
	marker: MdaitMarker,
	oldSourceHash: string | null,
	adoptTarget = false,
): void {
	const existingReviseHash = marker.getOldHashFromNeed();
	if (existingReviseHash) {
		// すでに revise 待ち。戻り先のスナップショットを動かさない
		marker.setReviseNeed(existingReviseHash);
	} else if (marker.need === "translate") {
		// まだ翻訳されていない。from だけ更新済みで need は据え置き
		marker.setNeed("translate");
	} else if (oldSourceHash) {
		// 翻訳済みで原文が変わった: 旧原文を戻り先にして改訂を要求する
		marker.setReviseNeed(oldSourceHash);
	} else if (adoptTarget) {
		// adopt: from 新規確立＋本文ありの既訳はレビューに倒す（trans の上書きを防ぐ）
		marker.setNeed("review");
	} else {
		marker.setNeed("translate");
	}
}

/**
 * ターゲット側マーカーを同期する
 * - 変更検出を行い、適切なneedフラグを設定
 *
 * @param context マーカー同期のコンテキスト
 * @returns 同期結果
 */
export function syncTargetMarker(context: MarkerSyncContext): MarkerSyncResult {
	const { sourceHash, targetHash, existingMarker } = context;

	// 新規マーカーの場合
	if (!existingMarker) {
		const marker = new MdaitMarker(targetHash ?? sourceHash, sourceHash);
		// 既訳の採用では「まだ訳していない」ではなく「人がまだ確かめていない」。
		// translate を付けると、次の trans が人の書いた訳を機械翻訳で上書きする
		// （実測: adopt 直後の frontmatter で、人の付けた英語タイトルが消えた）
		marker.setNeed(context.adoptTarget === true ? "review" : "translate");
		return {
			marker,
			changed: true,
			changeType: "new",
		};
	}

	// 変更検出
	const isSourceChanged = existingMarker.from !== sourceHash;
	const isTargetChanged =
		targetHash !== null && existingMarker.hash !== targetHash;

	// 原文が revise@ のスナップショットと同じところへ戻ったら、改訂すべき差分はもう無い
	// （syncMarkerPair と同じ理由。落とさないと need が永久に消えない）
	const revertedToTranslatedSource = existingMarker.getOldHashFromNeed() === sourceHash;
	if (revertedToTranslatedSource) {
		// **need を落としたらこの回はここで終える。** 下の分岐へ流すと、落としたそばから
		// `revise@{いまの from}` を立て直してしまう。from はすでに新しい原文を指しているので、
		// 立った印は**もう存在しない原文**を戻り先に持ち、以後 from === sourceHash で
		// この関数に入らなくなるため永久に消えない（実測: sync を何度回しても
		// `revise@S2` が残り続けた）。trans はその戻り先を引けず全文で訳し直すので、
		// frontmatter の手直しが消える
		existingMarker.removeNeedTag();
		existingMarker.from = sourceHash;
		if (targetHash) {
			existingMarker.hash = targetHash;
		}
		return {
			marker: existingMarker,
			changed: true,
			changeType: "source-changed",
		};
	}

	// ソースが変更された場合: revise または translate（両方変更時も同様に処理）
	if (isSourceChanged) {
		const oldSourceHash = existingMarker.from;
		existingMarker.from = sourceHash;
		applyNeedForChangedSource(existingMarker, oldSourceHash);

		// ターゲットハッシュを常に最新に更新
		if (targetHash) {
			existingMarker.hash = targetHash;
		}

		return {
			marker: existingMarker,
			changed: true,
			changeType: "source-changed",
		};
	}

	// ターゲットのみ変更: ハッシュを更新
	if (isTargetChanged && targetHash) {
		existingMarker.hash = targetHash;
		return {
			marker: existingMarker,
			changed: true,
			changeType: "target-changed",
		};
	}

	// 変更なし
	return {
		marker: existingMarker,
		changed: false,
		changeType: "none",
	};
}

/**
 * ペア同期用の結果
 */
export interface PairSyncResult {
	/** ソース側マーカー */
	sourceMarker: MdaitMarker;
	/** ターゲット側マーカー */
	targetMarker: MdaitMarker;
	/** 変更があったかどうか */
	changed: boolean;
}

/**
 * ペア同期のオプション
 */
export interface PairSyncOptions {
	/**
	 * 採用（adopt）モード: マーカーなし・本文ありの既存訳文を翻訳済みとして採用する。
	 * from を新規確立するユニット（need 未設定）に need:translate の代わりに need:review を付与し、
	 * trans による既訳の上書きを防ぐ。呼び出し側は「ターゲット本文が空でない」ことを確認して渡すこと。
	 */
	adoptTarget?: boolean;
	/**
	 * isolate ペア（source が need:isolate）の凍結: hash / from は最新化するが、
	 * setNeed / setReviseNeed を一切呼ばず既存の need を変更しない
	 * （ペアのリンクは維持しつつ、新しい翻訳需要を下流に流さない）。
	 */
	suppressNeed?: boolean;
}

/**
 * ソース・ターゲットペアのマーカーを同期する。
 *
 * **紐（原文マーカーの `hash` と訳文の `from`）は必ずそろえて動かす。** 片方だけ止めると
 * 次の sync で対応が見つからず（`section-matcher.ts` の Phase 1 が外れ、Phase 2 は `from` を
 * 持つ訳文を拾い直さない）、訳文は「原文が消えた孤立」に落ちて既定設定で物理削除される。
 *
 * かつて `need:review`（人がまだ確かめていない）だけは、確認の機会を守るために訳文側の
 * `from` を据え置いていた（旧 ADR-260831-02）。だが同じ sync が原文側の `hash` は進めるため、
 * **その場で紐が切れて既訳の本文がまるごと消えていた**（実測）。いま `review` は他の印と
 * 同じく `revise@{旧原文hash}` へ倒れる。原文が先へ進んだ以上「この訳文は旧原文の訳として
 * 妥当か」を人に聞くこと自体が現物と合っておらず、失う確認の機会より紐が切れて原稿が
 * 消えることのほうが重い（ADR-260901-01）。凍結したい印を足したくなったら、`from` を
 * 止める以外の道を探すこと。
 *
 * @param sourceHash ソースコンテンツのハッシュ
 * @param targetHash ターゲットコンテンツのハッシュ
 * @param existingSourceMarker 既存のソースマーカー
 * @param existingTargetMarker 既存のターゲットマーカー
 * @param options ペア同期のオプション
 * @returns ペア同期結果
 */
export function syncMarkerPair(
	sourceHash: string,
	targetHash: string,
	existingSourceMarker: MdaitMarker | null,
	existingTargetMarker: MdaitMarker | null,
	options?: PairSyncOptions,
): PairSyncResult {
	// 新規作成かどうかを判定
	const isNewTarget = existingTargetMarker === null;

	// ソースマーカーを作成/更新
	const sourceMarker = existingSourceMarker ?? new MdaitMarker(sourceHash);
	const targetMarker =
		existingTargetMarker ?? new MdaitMarker(targetHash, sourceMarker.hash);

	const isSourceChanged = sourceMarker.hash !== sourceHash;
	const isTargetChanged = targetMarker.hash !== targetHash;

	// ソースハッシュを常に最新に更新
	sourceMarker.hash = sourceHash;

	// ターゲットハッシュを常に最新に更新
	targetMarker.hash = targetHash;

	// 新規ターゲットの場合は need:translate を設定（suppressNeed 時は need を触らない）
	if (isNewTarget) {
		if (!options?.suppressNeed) {
			targetMarker.setNeed("translate");
		}
		return {
			sourceMarker,
			targetMarker,
			changed: true,
		};
	}

	// ソースの変更をターゲットに反映（両方変更時も同様に処理）
	const oldSourceHash = targetMarker.from;
	// 原文が revise@ のスナップショットと同じところへ戻ったら、改訂すべき差分はもう無い。
	// 打ち間違いの取り消し・ブランチの切り替え・`git checkout --` で日常的に起きる。
	// 落とさないと「まだ N 件残っている」に永久に居座り（sync を何度回しても消えない）、
	// しかも trans がその章を patch ではなく全文で訳し直して手直しを消す
	const revertedToTranslatedSource =
		!options?.suppressNeed && targetMarker.getOldHashFromNeed() === sourceMarker.hash;
	if (revertedToTranslatedSource) {
		targetMarker.removeNeedTag();
	}

	// 原文が変わったら `from` も必ず一緒に進める（この関数の説明の「紐」を見よ）
	if (oldSourceHash !== sourceMarker.hash) {
		targetMarker.from = sourceMarker.hash;

		if (!options?.suppressNeed && !revertedToTranslatedSource) {
			applyNeedForChangedSource(targetMarker, oldSourceHash, options?.adoptTarget === true);
		}
	}

	return {
		sourceMarker,
		targetMarker,
		changed:
			isSourceChanged || isTargetChanged || oldSourceHash !== sourceMarker.hash || revertedToTranslatedSource,
	};
}
