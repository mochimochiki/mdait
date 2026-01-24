/**
 * marker-sync.ts のユニットテスト
 * マーカー同期の共通ロジックをテスト
 */

import { strict as assert } from "node:assert";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { syncMarkerPair, syncSourceMarker, syncTargetMarker } from "../../../commands/sync/marker-sync";

suite("marker-sync", () => {
	suite("syncSourceMarker", () => {
		test("新規マーカー作成時、hashのみ設定されること", () => {
			const result = syncSourceMarker("abc123", null);

			assert.strictEqual(result.marker.hash, "abc123");
			assert.strictEqual(result.marker.from, null);
			assert.strictEqual(result.marker.need, null);
			assert.strictEqual(result.changed, true);
			assert.strictEqual(result.changeType, "new");
		});

		test("ハッシュ変更時、hashが更新されること", () => {
			const existing = new MdaitMarker("old123");
			const result = syncSourceMarker("new456", existing);

			assert.strictEqual(result.marker.hash, "new456");
			assert.strictEqual(result.changed, true);
			assert.strictEqual(result.changeType, "source-changed");
		});

		test("ハッシュ未変更時、変更なしとなること", () => {
			const existing = new MdaitMarker("abc123");
			const result = syncSourceMarker("abc123", existing);

			assert.strictEqual(result.marker.hash, "abc123");
			assert.strictEqual(result.changed, false);
			assert.strictEqual(result.changeType, "none");
		});
	});

	suite("syncTargetMarker", () => {
		test("新規マーカー作成時、need:translateが設定されること", () => {
			const result = syncTargetMarker({
				sourceHash: "src123",
				targetHash: "tgt456",
				existingMarker: null,
			});

			assert.strictEqual(result.marker.hash, "tgt456");
			assert.strictEqual(result.marker.from, "src123");
			assert.strictEqual(result.marker.need, "translate");
			assert.strictEqual(result.changed, true);
			assert.strictEqual(result.changeType, "new");
		});

		test("新規マーカー作成時、targetHashがnullの場合sourceHashが使われること", () => {
			const result = syncTargetMarker({
				sourceHash: "src123",
				targetHash: null,
				existingMarker: null,
			});

			assert.strictEqual(result.marker.hash, "src123");
			assert.strictEqual(result.marker.from, "src123");
			assert.strictEqual(result.marker.need, "translate");
		});

		test("ソース変更時（初回から）、need:translateが設定されること", () => {
			// 初回sync後のマーカー（fromなし）
			const existing = new MdaitMarker("tgt456", null);
			const result = syncTargetMarker({
				sourceHash: "src789",
				targetHash: "tgt456",
				existingMarker: existing,
			});

			assert.strictEqual(result.marker.from, "src789");
			assert.strictEqual(result.marker.need, "translate");
			assert.strictEqual(result.changeType, "source-changed");
		});

		test("ソース変更時（既存から）、need:revise@{oldhash}が設定されること", () => {
			const existing = new MdaitMarker("tgt456", "src123");
			const result = syncTargetMarker({
				sourceHash: "src789",
				targetHash: "tgt456",
				existingMarker: existing,
			});

			assert.strictEqual(result.marker.from, "src789");
			assert.strictEqual(result.marker.need, "revise@src123");
			assert.strictEqual(result.changeType, "source-changed");
		});

		test("ターゲットのみ変更時、hashのみ更新されneedは設定されないこと", () => {
			const existing = new MdaitMarker("tgt456", "src123");
			const result = syncTargetMarker({
				sourceHash: "src123",
				targetHash: "tgt789",
				existingMarker: existing,
			});

			assert.strictEqual(result.marker.hash, "tgt789");
			assert.strictEqual(result.marker.from, "src123");
			assert.strictEqual(result.marker.need, null);
			assert.strictEqual(result.changeType, "target-changed");
		});

		test("競合時（両方変更）、need:solve-conflictが設定されること", () => {
			const existing = new MdaitMarker("tgt456", "src123");
			const result = syncTargetMarker({
				sourceHash: "src789",
				targetHash: "tgt999",
				existingMarker: existing,
			});

			assert.strictEqual(result.marker.need, "solve-conflict");
			assert.strictEqual(result.changeType, "conflict");
			// 競合時はハッシュを更新しない
			assert.strictEqual(result.marker.hash, "tgt456");
			assert.strictEqual(result.marker.from, "src123");
		});

		test("変更なし時、changedがfalseとなること", () => {
			const existing = new MdaitMarker("tgt456", "src123");
			const result = syncTargetMarker({
				sourceHash: "src123",
				targetHash: "tgt456",
				existingMarker: existing,
			});

			assert.strictEqual(result.changed, false);
			assert.strictEqual(result.changeType, "none");
		});
	});

	suite("syncMarkerPair", () => {
		test("新規ペア作成時、ソースにhash、ターゲットにfromとneed:translateが設定されること", () => {
			const result = syncMarkerPair("src123", "tgt456", null, null);

			assert.strictEqual(result.sourceMarker.hash, "src123");
			assert.strictEqual(result.sourceMarker.from, null);
			assert.strictEqual(result.sourceMarker.need, null);

			assert.strictEqual(result.targetMarker.hash, "tgt456");
			assert.strictEqual(result.targetMarker.from, "src123");
			assert.strictEqual(result.targetMarker.need, "translate");

			assert.strictEqual(result.changed, true);
			assert.strictEqual(result.hasConflict, false);
		});

		test("ソース変更時、ターゲットにneed:revise@{oldhash}が設定されること", () => {
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");

			const result = syncMarkerPair("src789", "tgt456", existingSource, existingTarget);

			assert.strictEqual(result.sourceMarker.hash, "src789");
			assert.strictEqual(result.targetMarker.from, "src789");
			assert.strictEqual(result.targetMarker.need, "revise@src123");
			assert.strictEqual(result.hasConflict, false);
		});

		test("競合時、両方にneed:solve-conflictが設定されること", () => {
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");

			const result = syncMarkerPair("src789", "tgt999", existingSource, existingTarget);

			assert.strictEqual(result.sourceMarker.need, "solve-conflict");
			assert.strictEqual(result.targetMarker.need, "solve-conflict");
			assert.strictEqual(result.hasConflict, true);
			// 競合時はハッシュを更新しない
			assert.strictEqual(result.sourceMarker.hash, "src123");
			assert.strictEqual(result.targetMarker.hash, "tgt456");
		});

		test("変更なし時、changedがfalseとなること", () => {
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");

			const result = syncMarkerPair("src123", "tgt456", existingSource, existingTarget);

			assert.strictEqual(result.changed, false);
			assert.strictEqual(result.hasConflict, false);
		});
	});
});
