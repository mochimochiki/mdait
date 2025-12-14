// 見出し無しユニットを含む場合のSectionMatcher挙動を固定するテスト
// テストガイドラインに従いテスト実装します。

import { strict as assert } from "node:assert";
import { SectionMatcher } from "../../../commands/sync/section-matcher";
import { calculateHash } from "../../../core/hash/hash-calculator";
import { MdaitMarker } from "../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../core/markdown/mdait-unit";

suite("SectionMatcher（見出し無しユニット）", () => {
	test("source見出し無しユニットがtargetのfromでマッチし、削除扱いにならないこと", () => {
		const sourceContent = "本文A（見出し無し）\n";
		const sourceHash = calculateHash(sourceContent);
		const sourceUnits = [new MdaitUnit(new MdaitMarker(sourceHash), "", 0, sourceContent, 0, 0)];

		// 既存翻訳ユニット（target側）: from が sourceHash を指している
		const targetContent = "Translated A\n";
		const targetHash = calculateHash(targetContent);
		const targetUnits = [new MdaitUnit(new MdaitMarker(targetHash, sourceHash, null), "", 0, targetContent, 0, 0)];

		const matcher = new SectionMatcher();
		const matched = matcher.match(sourceUnits, targetUnits);

		assert.strictEqual(matched.length, 1);
		assert.ok(matched[0].source);
		assert.ok(matched[0].target);
		assert.strictEqual(matched[0].target?.getSourceHash(), sourceHash);
	});

	test("ハッシュが空のマーカーを持つユニットでもマッチング可能であること", () => {
		// 手動で<!-- mdait -->を追加した場合（ハッシュが空）
		const sourceContent = "手動で追加した本文\n";
		const sourceUnits = [new MdaitUnit(new MdaitMarker(""), "", 0, sourceContent, 0, 0)];

		// target側は未作成
		const targetUnits: MdaitUnit[] = [];

		const matcher = new SectionMatcher();
		const matched = matcher.match(sourceUnits, targetUnits);

		// 新規ユニットとして扱われる
		assert.strictEqual(matched.length, 1);
		assert.ok(matched[0].source);
		assert.strictEqual(matched[0].target, null);
	});
});
