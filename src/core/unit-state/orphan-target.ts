/**
 * @file orphan-target.ts
 * @description
 *   「原文と結びついていない訳文」（孤立訳文）の判定。
 *
 *   **この事実はどこにも記録しない。呼ぶたびにディスクから計算する**（ADR-260806-01）。
 *   記録すると `unit-state` の7列固定を破ることになり、さらに「いつ孤立したか」を覚える以上
 *   その行の寿命（何回で退避するか・退避ファイルをどう扱うか）を決めなければならなくなる。
 *   計算に倒すと寿命という概念ごと消える — 原文が戻れば次に計算したとき孤立でなくなる。
 *
 *   判定材料がディスク上のファイルの有無だけなので、マーカーの保管方式に依存しない。
 *   `unit-state` を持たない embedded でも同じ判定が効く（ux.md の F-10）。
 *
 * @module core/unit-state/orphan-target
 */

/** 孤立判定が外の世界に問い合わせること */
export interface OrphanTargetProbe {
	/**
	 * 訳文パスから対応する原文パスを導出する。
	 * どの pair の訳文ディレクトリ配下でもなければ `null`（＝訳文ではない）。
	 */
	deriveSourcePath(targetPath: string): string | null;
	/** ファイルがディスクに実在するか */
	exists(filePath: string): boolean;
}

/**
 * その訳文は原文と結びついていないか。
 *
 * 真になるのは「**その訳文ファイルは実在する。しかしそこから導いた原文ファイルは実在しない**」
 * のときだけである。次の2つは孤立ではない:
 *
 * - 訳文の実体が無い（§8 の (a)）— 消えたのはファイルそのものなので、見せる相手がいない
 * - 訳文ディレクトリの配下ではない（原文側・管理対象外）— 対応する原文という概念が無い
 */
export function isOrphanTarget(targetPath: string, probe: OrphanTargetProbe): boolean {
	if (!probe.exists(targetPath)) {
		return false;
	}
	const sourcePath = probe.deriveSourcePath(targetPath);
	if (sourcePath === null) {
		return false;
	}
	return !probe.exists(sourcePath);
}
