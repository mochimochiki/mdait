// SectionMatcher の網羅性（どの並びでもユニットを取りこぼさない）の検証。
//
// match() は「from 一致で確定した組」を錨にして区間を切り、区間の中を順序で埋める。
// **錨が単調である（source 順に並べたとき target の位置も増えていく）ことを確かめていない。**
// 章を並べ替えると錨は交差しうるので、区間の始点と終点が逆転する。逆転した区間に落ちた
// ユニットが結果に載らないと、createSyncedTargets が結果から訳文を組み立てる以上、
// **その訳文ユニットはファイルから消える**。
//
// unit-state 側の突き合わせ（interval-align）は selectMonotonicAnchors で単調な部分だけを
// 枠に使うことでこれを避けている。SectionMatcher の載せ替えは未了なので（unit-state.md §10）、
// 少なくとも「取りこぼさない」ことはここで見張る。

import * as assert from "node:assert";
import { SectionMatcher } from "../../../../commands/sync/section-matcher";
import { MdaitMarker } from "../../../../core/markdown/mdait-marker";
import { MdaitUnit } from "../../../../core/markdown/mdait-unit";

/** 原文ユニット（hash だけ持つ） */
function sourceUnit(hash: string): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash), `S-${hash}`, 2, `## S-${hash}\n\nbody\n`, 0, 0);
}

/** 訳文ユニット。from を与えると原文と結びついた訳、省略すると人が足したユニット */
function targetUnit(hash: string, from?: string): MdaitUnit {
	return new MdaitUnit(new MdaitMarker(hash, from ?? null, null), `T-${hash}`, 2, `## T-${hash}\n\nbody\n`, 0, 0);
}

/** 結果にすべての原文・訳文がちょうど1回ずつ現れるか */
function assertCovers(result: ReturnType<SectionMatcher["match"]>, sources: MdaitUnit[], targets: MdaitUnit[]): void {
	for (const unit of sources) {
		const hits = result.filter((p) => p.source === unit).length;
		assert.strictEqual(hits, 1, `原文 ${unit.title} が結果に${hits}回しか現れない`);
	}
	for (const unit of targets) {
		const hits = result.filter((p) => p.target === unit).length;
		assert.strictEqual(hits, 1, `訳文 ${unit.title} が結果に${hits}回しか現れない（消えると本文ごと失われる）`);
	}
}

suite("SectionMatcher の網羅性", () => {
	const matcher = new SectionMatcher();

	test("素直な並びでは全ユニットが結果に現れること", () => {
		const sources = [sourceUnit("a"), sourceUnit("b"), sourceUnit("c")];
		const targets = [targetUnit("ta", "a"), targetUnit("tb", "b"), targetUnit("tc", "c")];

		assertCovers(matcher.match(sources, targets), sources, targets);
	});

	test("訳文の章が並べ替えられていても全ユニットが結果に現れること", () => {
		// 錨が交差する形（source 順 a,b,c に対し target は c,a,b）
		const sources = [sourceUnit("a"), sourceUnit("b"), sourceUnit("c")];
		const targets = [targetUnit("tc", "c"), targetUnit("ta", "a"), targetUnit("tb", "b")];

		assertCovers(matcher.match(sources, targets), sources, targets);
	});

	test("並べ替えに、人が足した from なしユニットが混ざっていても消えないこと", () => {
		const sources = [sourceUnit("a"), sourceUnit("b"), sourceUnit("c")];
		const added = targetUnit("tx");
		const targets = [targetUnit("tc", "c"), added, targetUnit("ta", "a"), targetUnit("tb", "b")];

		assertCovers(matcher.match(sources, targets), sources, targets);
	});

	test("錨の交差と新旧の増減が同時に起きても取りこぼさないこと", () => {
		// 章の並べ替え・原文だけの追加・訳文だけの追加が重なった形
		const sources = [sourceUnit("a"), sourceUnit("b"), sourceUnit("c"), sourceUnit("d")];
		const targets = [
			targetUnit("td", "d"),
			targetUnit("tx"),
			targetUnit("tb", "b"),
			targetUnit("ty"),
			targetUnit("ta", "a"),
		];

		assertCovers(matcher.match(sources, targets), sources, targets);
	});

	test("総当たりの並べ替えで一度も取りこぼさないこと", () => {
		// 4章ぶんの並べ替え24通り。区間の逆転は特定の並びでだけ起きるので、
		// 代表例を1つ2つ見るだけでは足りない
		const hashes = ["a", "b", "c", "d"];
		const permutations: string[][] = [];
		const permute = (rest: string[], acc: string[]): void => {
			if (rest.length === 0) {
				permutations.push([...acc]);
				return;
			}
			for (let i = 0; i < rest.length; i++) {
				permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
			}
		};
		permute(hashes, []);
		assert.strictEqual(permutations.length, 24, "前提: 24通り");

		for (const order of permutations) {
			const sources = hashes.map(sourceUnit);
			const targets = order.map((h) => targetUnit(`t${h}`, h));
			assertCovers(matcher.match(sources, targets), sources, targets);
		}
	});
});
