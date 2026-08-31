/**
 * marker-sync.ts のユニットテスト
 * マーカー同期の共通ロジックをテスト
 */

import { strict as assert } from "node:assert";
import {
	syncMarkerPair,
	syncSourceMarker,
	syncTargetMarker,
} from "../../../../commands/sync/marker-sync";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";

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

		test("原文を元に戻すと need:revise が消えること（打ち消しの取り消し・ブランチ切り替え）", () => {
			// 訳し終わった原文 src123 → 編集して src789（need:revise@src123）→ 元に戻して src123。
			// スナップショットと原文が同じところへ戻ったのだから、改訂すべき差分はもう無い。
			// 落とさないと sync を何度回しても消えず、翻訳待ちの数え上げに永久に居座り、
			// trans がその章を全文で訳し直して手直しを消す（実測）
			const existingSource = new MdaitMarker("src789");
			const existingTarget = new MdaitMarker("tgt456", "src789", "revise@src123");

			const result = syncMarkerPair("src123", "tgt456", existingSource, existingTarget);

			assert.strictEqual(result.targetMarker.from, "src123");
			assert.strictEqual(result.targetMarker.need, null, "need が落ちること");
			assert.strictEqual(result.changed, true, "書き戻さないと次の sync でまた同じ判断をする");
		});

		test("from が既に揃っているのに revise@ が残っている行き止まりも、その場で解ける", () => {
			// 以前の版が作った `from:X need:revise@X`。from が動かないので、
			// 変更検出の中だけで直そうとすると永久に手が届かない
			const existingTarget = new MdaitMarker("tgt456", "src123", "revise@src123");

			const result = syncMarkerPair("src123", "tgt456", new MdaitMarker("src123"), existingTarget);

			assert.strictEqual(result.targetMarker.need, null);
			assert.strictEqual(result.changed, true);
		});

		test("スナップショットと違う原文へ変わったときは、これまでどおり revise を持ち回す", () => {
			const existingTarget = new MdaitMarker("tgt456", "src789", "revise@src123");

			const result = syncMarkerPair("srcABC", "tgt456", new MdaitMarker("src789"), existingTarget);

			assert.strictEqual(result.targetMarker.need, "revise@src123", "最初の版を指したままにすること");
		});

		test("未翻訳状態（need:translate）でソースが変更された場合、need:translateが維持されること", () => {
			// 初回sync済みだがまだ翻訳していない状態（from値あり、need:translate）
			const existing = new MdaitMarker("tgt456", "src123");
			existing.setNeed("translate");
			const result = syncTargetMarker({
				sourceHash: "src789",
				targetHash: "tgt456",
				existingMarker: existing,
			});

			// 未翻訳なのでreviseではなくtranslateのまま維持されるべき
			assert.strictEqual(result.marker.from, "src789");
			assert.strictEqual(
				result.marker.need,
				"translate",
				"未翻訳ファイルはneed:reviseにならないこと",
			);
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

		test("両方変更時（ソース+ターゲット）、need:revise@{oldhash}が設定されハッシュも更新されること", () => {
			const existing = new MdaitMarker("tgt456", "src123");
			const result = syncTargetMarker({
				sourceHash: "src789",
				targetHash: "tgt999",
				existingMarker: existing,
			});

			assert.strictEqual(result.marker.need, "revise@src123");
			assert.strictEqual(result.changeType, "source-changed");
			// 両方変更時もハッシュを最新に更新
			assert.strictEqual(result.marker.hash, "tgt999");
			assert.strictEqual(result.marker.from, "src789");
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

		test("revise前に原文が再変更された場合、need:revise@{hash}が保持されること", () => {
			// 翻訳完了状態から原文変更①でneed:revise@src123が設定された状態
			const existing = new MdaitMarker("tgt456", "src789");
			existing.setReviseNeed("src123");

			// 原文変更②が発生
			const result = syncTargetMarker({
				sourceHash: "src999",
				targetHash: "tgt456",
				existingMarker: existing,
			});

			// fromは最新に更新されるが、needのスナップショットハッシュは保持される
			assert.strictEqual(result.marker.from, "src999");
			assert.strictEqual(
				result.marker.need,
				"revise@src123",
				"改訂前の再変更時はneed:revise@src123が保持されるべき",
			);
			assert.strictEqual(result.changeType, "source-changed");
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
		});

		test("ソース変更時、ターゲットにneed:revise@{oldhash}が設定されること", () => {
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");

			const result = syncMarkerPair(
				"src789",
				"tgt456",
				existingSource,
				existingTarget,
			);

			assert.strictEqual(result.sourceMarker.hash, "src789");
			assert.strictEqual(result.targetMarker.from, "src789");
			assert.strictEqual(result.targetMarker.need, "revise@src123");
		});

		test("未翻訳状態（need:translate）でソースが変更された場合、need:translateが維持されること", () => {
			// sync済みだがまだ翻訳していない状態（from値あり、need:translate）
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");
			existingTarget.setNeed("translate");

			const result = syncMarkerPair(
				"src789",
				"tgt456",
				existingSource,
				existingTarget,
			);

			// 未翻訳なのでreviseではなくtranslateのまま維持されるべき
			assert.strictEqual(result.targetMarker.from, "src789");
			assert.strictEqual(
				result.targetMarker.need,
				"translate",
				"未翻訳ファイルはneed:reviseにならないこと",
			);
		});

		test("両方変更時、ターゲットにneed:revise@{oldhash}が設定されハッシュも更新されること", () => {
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");

			const result = syncMarkerPair(
				"src789",
				"tgt999",
				existingSource,
				existingTarget,
			);

			// ソースはneedを設定しない
			assert.strictEqual(result.sourceMarker.need, null);
			// ターゲットはreviseを設定
			assert.strictEqual(result.targetMarker.need, "revise@src123");
			// 両方のハッシュが最新に更新される
			assert.strictEqual(result.sourceMarker.hash, "src789");
			assert.strictEqual(result.targetMarker.hash, "tgt999");
			assert.strictEqual(result.changed, true);
		});

		test("変更なし時、changedがfalseとなること", () => {
			const existingSource = new MdaitMarker("src123");
			const existingTarget = new MdaitMarker("tgt456", "src123");

			const result = syncMarkerPair(
				"src123",
				"tgt456",
				existingSource,
				existingTarget,
			);

			assert.strictEqual(result.changed, false);
		});

		test("revise前に原文が再変更された場合（syncMarkerPair）、need:revise@{hash}が保持されること", () => {
			// 翻訳完了状態から原文変更①でneed:revise@src123が設定された状態
			const existingSource = new MdaitMarker("src789");
			const existingTarget = new MdaitMarker("tgt456", "src789");
			existingTarget.setReviseNeed("src123");

			// 原文変更②が発生
			const result = syncMarkerPair(
				"src999",
				"tgt456",
				existingSource,
				existingTarget,
			);

			// fromは最新に更新されるが、needのスナップショットハッシュは保持される
			assert.strictEqual(result.targetMarker.from, "src999");
			assert.strictEqual(
				result.targetMarker.need,
				"revise@src123",
				"改訂前の再変更時はneed:revise@src123が保持されるべき",
			);
		});

		suite("adoptTarget オプション（既存対訳の採用）", () => {
			test("from新規確立＋needなし＋adopt → need:review が付き既訳が採用される", () => {
				// マーカーなし既訳のsync: ensureMdaitMarkerHashによりhashのみのマーカーが付いた状態
				const tgtMarker = new MdaitMarker("tgt123");
				const result = syncMarkerPair("src123", "tgt123", null, tgtMarker, {
					adoptTarget: true,
				});
				assert.strictEqual(result.targetMarker.from, "src123");
				assert.strictEqual(result.targetMarker.need, "review");
			});

			test("adoptなしの同条件では need:translate（従来動作の維持）", () => {
				const tgtMarker = new MdaitMarker("tgt123");
				const result = syncMarkerPair("src123", "tgt123", null, tgtMarker);
				assert.strictEqual(result.targetMarker.need, "translate");
			});

			test("adoptでも新規ターゲット（マーカーなし）は need:translate", () => {
				const result = syncMarkerPair("src123", "src123", null, null, {
					adoptTarget: true,
				});
				assert.strictEqual(result.targetMarker.need, "translate");
			});

			test("adoptでも既にfrom確立済みのユニットには影響しない", () => {
				const tgtMarker = new MdaitMarker("tgt123", "src123", null);
				const result = syncMarkerPair("src123", "tgt123", new MdaitMarker("src123"), tgtMarker, {
					adoptTarget: true,
				});
				assert.strictEqual(result.targetMarker.need, null);
			});

			test("adopt済みユニットの2回目のsyncは無変更（冪等性）", () => {
				const tgtMarker = new MdaitMarker("tgt123");
				const first = syncMarkerPair("src123", "tgt123", null, tgtMarker, {
					adoptTarget: true,
				});
				// 2回目: from確立済み・need:review
				const second = syncMarkerPair("src123", "tgt123", first.sourceMarker, first.targetMarker, {
					adoptTarget: true,
				});
				assert.strictEqual(second.targetMarker.from, "src123");
				assert.strictEqual(second.targetMarker.need, "review");
				assert.strictEqual(second.targetMarker.hash, "tgt123");
			});

			test("adoptで採用されたユニットはtransの対象にならない（needsTranslation=false）", () => {
				const tgtMarker = new MdaitMarker("tgt123");
				const result = syncMarkerPair("src123", "tgt123", null, tgtMarker, {
					adoptTarget: true,
				});
				assert.strictEqual(result.targetMarker.needsTranslation(), false);
			});

			test("adopt採用後にソースが変更されたら通常のreviseフローに乗る", () => {
				const tgtMarker = new MdaitMarker("tgt123", "src123", null); // レビュー承認済み（need除去済み）
				const result = syncMarkerPair("src456", "tgt123", new MdaitMarker("src456"), tgtMarker);
				assert.strictEqual(result.targetMarker.need, "revise@src123");
			});
		});

		suite("suppressNeed オプション（isolateペアの凍結）", () => {
			test("ソース変更時、hashとfromは更新されるがneedが付かないこと（reviseを流さない）", () => {
				const existingSource = new MdaitMarker("src123", null, "isolate");
				const existingTarget = new MdaitMarker("tgt456", "src123", null);

				const result = syncMarkerPair("src789", "tgt999", existingSource, existingTarget, {
					suppressNeed: true,
				});

				assert.strictEqual(result.sourceMarker.hash, "src789");
				assert.strictEqual(result.sourceMarker.need, "isolate", "source側のneedは変更されないこと");
				assert.strictEqual(result.targetMarker.hash, "tgt999");
				assert.strictEqual(result.targetMarker.from, "src789");
				assert.strictEqual(result.targetMarker.need, null, "reviseが付かないこと");
			});

			test("既存のneedはそのまま維持されること（revise@のスナップショットも書き換えない）", () => {
				const existingSource = new MdaitMarker("src789", null, "isolate");
				const existingTarget = new MdaitMarker("tgt456", "src789");
				existingTarget.setReviseNeed("src123");

				const result = syncMarkerPair("src999", "tgt456", existingSource, existingTarget, {
					suppressNeed: true,
				});

				assert.strictEqual(result.targetMarker.from, "src999");
				assert.strictEqual(result.targetMarker.need, "revise@src123", "既存needは不変であること");
			});

			test("新規ターゲットにも need:translate を付与しないこと", () => {
				const result = syncMarkerPair("src123", "tgt456", new MdaitMarker("src123", null, "isolate"), null, {
					suppressNeed: true,
				});
				assert.strictEqual(result.targetMarker.from, "src123");
				assert.strictEqual(result.targetMarker.need, null);
			});

			test("変更なし時は何も変わらないこと（冪等）", () => {
				const existingSource = new MdaitMarker("src123", null, "isolate");
				const existingTarget = new MdaitMarker("tgt456", "src123", null);

				const result = syncMarkerPair("src123", "tgt456", existingSource, existingTarget, {
					suppressNeed: true,
				});

				assert.strictEqual(result.changed, false);
				assert.strictEqual(result.targetMarker.need, null);
			});
		});

		suite("人の裁定待ち（need:review）の凍結", () => {
			test("need:review のまま原文が変わっても、need も from も動かないこと", () => {
				// adopt で採用された既訳。人がまだ「この訳文で合っている」と言っていない
				const target = new MdaitMarker("tgt456", "src123", "review");

				const result = syncMarkerPair("src999", "tgt456", new MdaitMarker("src999"), target);

				assert.strictEqual(
					result.targetMarker.need,
					"review",
					"確認待ちの印が revise@ に化けると、人が一度も見ないまま AI が訳文を書き換える",
				);
				assert.strictEqual(
					result.targetMarker.from,
					"src123",
					"from を進めると、印が外れたときに改訂の戻り先が失われる",
				);
			});

			test("凍結中のユニットは trans の対象にならないこと", () => {
				const target = new MdaitMarker("tgt456", "src123", "review");
				const result = syncMarkerPair("src999", "tgt456", new MdaitMarker("src999"), target);
				assert.strictEqual(result.targetMarker.needsTranslation(), false);
			});

			test("凍結中に原文を何度変えても、from は最初の原文のまま保たれること", () => {
				let target = new MdaitMarker("tgt456", "src123", "review");
				for (const hash of ["src777", "src888", "src999"]) {
					target = syncMarkerPair(hash, "tgt456", new MdaitMarker(hash), target).targetMarker;
				}
				assert.strictEqual(target.from, "src123");
				assert.strictEqual(target.need, "review");
			});

			test("人が確認を終えて印を外すと、次の sync で正しい戻り先の revise@ が立つこと", () => {
				const target = new MdaitMarker("tgt456", "src123", "review");
				const frozen = syncMarkerPair("src999", "tgt456", new MdaitMarker("src999"), target).targetMarker;

				// 人が「この訳文で合っている」と確定した（need を外す）
				frozen.removeNeedTag();

				const result = syncMarkerPair("src999", "tgt456", new MdaitMarker("src999"), frozen);
				assert.strictEqual(
					result.targetMarker.need,
					"revise@src123",
					"凍結は改訂を消すのではなく保留する。確認が済んだら本来の改訂が立つ",
				);
				assert.strictEqual(result.targetMarker.from, "src999");
			});

			test("凍結中でも訳文の hash は最新化されること（人が訳文を直せる）", () => {
				const target = new MdaitMarker("tgt456", "src123", "review");
				const result = syncMarkerPair("src999", "tgt111", new MdaitMarker("src999"), target);
				assert.strictEqual(result.targetMarker.hash, "tgt111");
				assert.strictEqual(result.targetMarker.need, "review");
			});

			test("原文が変わっていなければ凍結は変更を報告しないこと（冪等）", () => {
				const target = new MdaitMarker("tgt456", "src123", "review");
				const result = syncMarkerPair("src123", "tgt456", new MdaitMarker("src123"), target);
				assert.strictEqual(result.changed, false);
				assert.strictEqual(result.targetMarker.need, "review");
			});
		});

		suite("frontmatter 経路（syncTargetMarker）も同じ守りを持つ", () => {
			test("need:review のまま原文が変わっても、need も from も動かないこと", () => {
				const result = syncTargetMarker({
					sourceHash: "src999",
					targetHash: "tgt456",
					existingMarker: new MdaitMarker("tgt456", "src123", "review"),
				});
				assert.strictEqual(result.marker.need, "review");
				assert.strictEqual(result.marker.from, "src123");
			});

			test("原文が revise@ の戻り先へ戻ったら need が消えること", () => {
				// 原文 src123 → src999 で revise が立ち、from は src999 を指している。
				// そこへ原文が src123 へ戻された（打ち間違いの取り消し・git checkout）
				const result = syncTargetMarker({
					sourceHash: "src123",
					targetHash: "tgt456",
					existingMarker: new MdaitMarker("tgt456", "src999", "revise@src123"),
				});
				assert.strictEqual(
					result.marker.need,
					null,
					"落とした印を立て直すと、もう存在しない原文を戻り先に持つ revise@ が永久に残る",
				);
				assert.strictEqual(result.marker.from, "src123");
			});

			test("原文を戻したあと sync を繰り返しても印は戻らないこと（冪等）", () => {
				let marker = new MdaitMarker("tgt456", "src999", "revise@src123");
				for (let i = 0; i < 3; i++) {
					marker = syncTargetMarker({
						sourceHash: "src123",
						targetHash: "tgt456",
						existingMarker: marker,
					}).marker;
				}
				assert.strictEqual(marker.need, null);
			});

			test("ふつうの改訂は従来どおり立つこと（凍結が効きすぎていない）", () => {
				const result = syncTargetMarker({
					sourceHash: "src999",
					targetHash: "tgt456",
					existingMarker: new MdaitMarker("tgt456", "src123", null),
				});
				assert.strictEqual(result.marker.need, "revise@src123");
				assert.strictEqual(result.marker.from, "src999");
			});
		});
	});
});
