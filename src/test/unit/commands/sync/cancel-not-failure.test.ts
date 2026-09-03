/**
 * @file cancel-not-failure.test.ts
 * @description 利用者が押した取り消しを、sync が「失敗」として数えないことを固定する。
 *
 * 背景: 取り込み（adopt + AIアライン）の途中で取り消すと、そのとき送信中だったファイルは
 * 中断の例外で終わる。これを失敗の数に入れていたため、自分で止めた人に「1 failed」と
 * 見せていた（ADR-260903-04 の備考）。押した本人にとって、これは事実に反する。
 *
 * 見張るのは2つ。
 *
 * 1. **何を中断と読むか**（`isCancelledFailure`）。型で見分けるのが基本だが、中断の投げ方は
 *    層ごとに揃っていない歴史があり、実際に素の `Error("AI align cancelled")` を投げていた
 *    箇所が残っていた。取り消し済みの合図が立っていれば型を問わず中断と読む。
 * 2. **数え先と、ステータスへの刻み方**。ここは `syncCommand` の奥（ワーカーの catch）にあり、
 *    単体で呼び出せない。`managed-write-only.test.ts` と同じくソースを突き合わせて固定する。
 *    失敗に数え直す変更も、赤いステータスを刻む変更も、この番人が落ちる。
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { chooseSyncCompletionNotice, isCancelledFailure } from "../../../../commands/sync/sync-command";
import { OperationCancelledError } from "../../../../infra/errors/operation-cancelled";

/** 取り消し済み／未取り消しの合図 */
function tokenOf(cancelled: boolean): vscode.CancellationToken {
	return {
		isCancellationRequested: cancelled,
		onCancellationRequested: () => ({ dispose: () => {} }),
	} as unknown as vscode.CancellationToken;
}

suite("取り消しは sync の失敗ではない", () => {
	test("中断の型で投げられた例外は、合図を渡さなくても中断と読むこと", () => {
		assert.equal(isCancelledFailure(new OperationCancelledError()), true);
	});

	test("素の Error でも、取り消し済みの合図が立っていれば中断と読むこと", () => {
		assert.equal(isCancelledFailure(new Error("AI align cancelled"), tokenOf(true)), true);
	});

	test("取り消していなければ、ふつうの失敗は失敗のままであること", () => {
		assert.equal(isCancelledFailure(new Error("ENOENT"), tokenOf(false)), false);
		assert.equal(isCancelledFailure(new Error("ENOENT")), false);
	});
});

/**
 * 完了時に出す通知の選び方。
 *
 * 取り消しは**合図で判定する**。件数（`cancelledCount`）だけを見ると、取り消しがファイルの
 * 合間に届いたときに 0 のままになる — そのときは例外が投げられず、ワーカーが次のファイルを
 * 取らずに抜けるだけだからである。AI を使わない定常 sync ではむしろこちらが普通の経路で、
 * 止めたのに「完了しました」と、場合によっては「今すぐ翻訳」まで出ていた。
 */
suite("取り消したときの完了通知", () => {
	test("取り消したら、翻訳待ちが残っていても中断だけを伝えること", () => {
		const notice = chooseSyncCompletionNotice({
			cancelled: true,
			successCount: 3,
			errorCount: 0,
			translatableCount: 42,
		});
		assert.equal(notice.kind, "cancelled", "止めた直後に次の AI 実行を勧めている");
		assert.deepEqual(notice, { kind: "cancelled", syncedCount: 3 });
	});

	test("1ファイルも途中で止まらなくても、取り消したなら中断と伝えること", () => {
		// ファイルの合間で取り消された場合。例外が投げられないので件数は 0 のまま
		const notice = chooseSyncCompletionNotice({
			cancelled: true,
			successCount: 5,
			errorCount: 0,
			translatableCount: 0,
		});
		assert.equal(notice.kind, "cancelled");
	});

	test("取り消していなければ、これまでどおりの完了サマリであること", () => {
		assert.equal(
			chooseSyncCompletionNotice({ cancelled: false, successCount: 3, errorCount: 1, translatableCount: 7 }).kind,
			"translatable",
		);
		assert.equal(
			chooseSyncCompletionNotice({ cancelled: false, successCount: 3, errorCount: 1, translatableCount: 0 }).kind,
			"plain",
		);
	});
});

suite("取り消しの数え先（ソース走査）", () => {
	/** リポジトリのルート（out/test/unit/commands/sync から5つ上） */
	const repoRoot = path.resolve(__dirname, "..", "..", "..", "..", "..");
	const sourcePath = path.join(repoRoot, "src", "commands", "sync", "sync-command.ts");
	const source = fs.readFileSync(sourcePath, "utf-8");

	/**
	 * ワーカーの catch を、中断の枝と失敗の枝に切り分ける。
	 * **目印が動いたら、通すのではなく落とす** — 見張る場所を見失ったまま緑になるのがいちばん困る。
	 */
	function catchBlock(): { cancelled: string; failure: string } {
		const head = source.indexOf("updateSourceEmptiedMemory(targetFile,");
		const failureLog = source.indexOf('logger.error("sync", "File sync error"');
		const failureCount = source.indexOf("errorCount++;");
		assert.notEqual(head, -1, "ワーカーの catch の直前が見つからない（目印が変わった）");
		assert.notEqual(failureLog, -1, "失敗のログが見つからない（目印が変わった）");
		assert.notEqual(failureCount, -1, "失敗を数える箇所が見つからない（目印が変わった）");
		assert.ok(head < failureLog && failureLog < failureCount, "catch の中の並びが想定と違う");
		return {
			cancelled: source.slice(head, failureLog),
			failure: source.slice(failureLog, failureCount),
		};
	}

	test("失敗を数えるより先に、中断かどうかを見ていること", () => {
		assert.ok(
			catchBlock().cancelled.includes("isCancelledFailure(error"),
			"ワーカーの catch から中断の判定が消えている（失敗として数え直している）",
		);
	});

	test("中断は失敗とは別の数に入れていること", () => {
		assert.ok(catchBlock().cancelled.includes("cancelledCount++"), "中断を失敗の数に入れている");
		assert.equal(count(source, "cancelledCount++;"), 1, "中断を数える箇所が1つでない");
		assert.equal(count(source, "errorCount++;"), 1, "失敗を数える箇所が1つでない");
	});

	test("中断のときはステータスにエラーを刻まないこと", () => {
		assert.ok(
			!catchBlock().cancelled.includes("changeFileStatusWithError"),
			"取り消しただけのファイルに赤いエラーを刻んでいる。刻むと次の sync まで「壊れている」と読める",
		);
	});

	test("取り消しの判定は件数ではなく合図を見ていること", () => {
		const line = source.split("\n").find((l) => l.includes("const cancelled ="));
		assert.ok(line, "取り消しの判定が見つからない（目印が変わった）");
		assert.ok(
			line.includes("isCancellationRequested"),
			"件数だけで取り消しを判定している。合間で取り消されると 0 のままで「完了しました」と出る",
		);
	});

	test("ふつうの失敗では、これまでどおりステータスにエラーを刻むこと", () => {
		// 上の番人を「刻む処理を丸ごと消す」ことで通してしまわないよう、裏も見る
		assert.ok(
			catchBlock().failure.includes("changeFileStatusWithError"),
			"失敗したファイルにエラーを刻まなくなっている",
		);
	});
});

/** 部分文字列の出現回数 */
function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}
