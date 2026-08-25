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
import { repairDeadSourceHashes } from "../../../../commands/sync/sync-command";
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
