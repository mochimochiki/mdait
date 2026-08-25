// 誰も指していない原文ハッシュの付け直し（repairDeadSourceHashes）の検証。
//
// 原文の hash は2つの顔を持つ。本文から計算できる値であることと、訳文の `from:` が
// 指す宛先であることだ。**どちらでもない hash は死んだ値**で、手編集の打ち間違いや
// マージの取りこぼしでこうなる。放っておくと対応付け（from === hash）が外れ、
// 位置ベースの救済も `from` を持つ訳文には効かないので、完成した訳文が
// 「原文が消えた」として削除される（ごみ箱を通らない）。実測でそうなった。
//
// 逆に、生きている hash に触ってはいけない。本文を編集しただけで対応付けが外れる。

import * as assert from "node:assert";
import { relinkRevertedTargets, repairDeadSourceHashes } from "../../../../commands/sync/sync-command";
import { calculateHash } from "../../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

const BODY = "## 章\n\n本文。\n";
const BODY_HASH = calculateHash(BODY);

/** 原文ユニット。hash を明示すると「マーカーにそう書いてある」状態を作れる */
function sourceUnit(hash: string, content = BODY): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash), "章", 2, content, 0, 0);
}

/** 訳文ユニット（from で原文を指す） */
function targetUnit(from: string): MdaitUnit {
	return new MdaitUnit(new MdaitMarker("tgt", from, null), "Section", 2, "## Section\n\nbody\n", 0, 0);
}

suite("誰も指していない原文ハッシュを本文から付け直す", () => {
	test("本文とも from とも合わない hash は、本文から付け直す", () => {
		const source = sourceUnit("00000000");
		const target = targetUnit(BODY_HASH);

		const repaired = repairDeadSourceHashes([source], [target]);

		assert.strictEqual(repaired, 1);
		assert.strictEqual(
			source.marker?.hash,
			BODY_HASH,
			"付け直せば from と一致し、訳文が孤立扱いで消されなくなる",
		);
	});

	test("訳文の from が指している hash には触らない（本文を編集した直後の正常な姿）", () => {
		const source = sourceUnit("old11111", "## 章\n\n本文。書き足した。\n");
		const target = targetUnit("old11111");

		const repaired = repairDeadSourceHashes([source], [target]);

		assert.strictEqual(repaired, 0);
		assert.strictEqual(source.marker?.hash, "old11111", "触ると改訂の追随ごと壊れる");
	});

	test("本文どおりの hash には触らない", () => {
		const source = sourceUnit(BODY_HASH);
		assert.strictEqual(repairDeadSourceHashes([source], []), 0);
		assert.strictEqual(source.marker?.hash, BODY_HASH);
	});

	test("付け直しても from と need はそのまま残す", () => {
		const source = sourceUnit("00000000");
		source.marker = new MdaitMarker("00000000", "upstream", "isolate");

		repairDeadSourceHashes([source], []);

		assert.strictEqual(source.marker?.hash, BODY_HASH);
		assert.strictEqual(source.marker?.from, "upstream");
		assert.strictEqual(source.marker?.need, "isolate");
	});

	test("hash を持たないユニットは対象外（付与は ensureMdaitMarkerHash の担当）", () => {
		const source = new MdaitUnit(new MdaitMarker(""), "章", 2, BODY, 0, 0);
		assert.strictEqual(repairDeadSourceHashes([source], []), 0);
	});
});

suite("原文がファイルごと前の版へ戻ったときに繋ぎ直す", () => {
	/** 訳文ユニット（from と need を指定できる） */
	function target(from: string, need: string | null): MdaitUnit {
		return new MdaitUnit(new MdaitMarker("tgt", from, need), "Section", 2, "## Section\n\ntranslated\n", 0, 0);
	}

	test("from の相手が居らず、revise@ の指す版が原文に在るなら、そこへ繋ぎ直す", () => {
		// `git checkout --` やブランチの切り替えで原文をファイルごと戻すと、原文のマーカーも
		// 前の版の hash に戻る。訳文の from は編集後の hash を指したままなので対応付けが外れ、
		// 訳し終えた章が「原文が消えた」として削除されていた（実測。ごみ箱も通らない）
		const source = sourceUnit("old11111");
		const tgt = target("edited99", "revise@old11111");

		assert.strictEqual(relinkRevertedTargets([source], [tgt]), 1);
		assert.strictEqual(tgt.marker?.from, "old11111", "元の相手へ戻ること");
	});

	test("from の相手が居るなら触らない（ふつうの改訂待ち）", () => {
		const source = sourceUnit("edited99");
		const tgt = target("edited99", "revise@old11111");

		assert.strictEqual(relinkRevertedTargets([source], [tgt]), 0);
		assert.strictEqual(tgt.marker?.from, "edited99");
	});

	test("戻り先が原文に無ければ、決めつけずにそのままにする（本当に章が消えた場合）", () => {
		const source = sourceUnit("other000");
		const tgt = target("edited99", "revise@old11111");

		assert.strictEqual(relinkRevertedTargets([source], [tgt]), 0);
		assert.strictEqual(tgt.marker?.from, "edited99", "孤立の判断は従来どおり行われる");
	});

	test("revise@ を持たない訳文は対象外（戻り先を知らない）", () => {
		const source = sourceUnit("old11111");
		const tgt = target("edited99", null);

		assert.strictEqual(relinkRevertedTargets([source], [tgt]), 0);
	});

	test("from を持たない訳文（独立ユニット）は対象外", () => {
		const source = sourceUnit("old11111");
		const tgt = target("", "revise@old11111");

		assert.strictEqual(relinkRevertedTargets([source], [tgt]), 0);
	});
});
