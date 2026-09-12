/**
 * 競合の判定の応答を検証する係のテスト（roadmap-v04 P02）。
 *
 * ここが持つ約束は「**読めないものは捨てて、決まらなかったことにする**」である。
 * 捨てた件は人が決める（P03）。黙って片方を採るより、残すほうが安全である。
 */

import { strict as assert } from "node:assert";
import { validateConflictResponse } from "../../../../commands/conflict/conflict-response-validator";

const ok = (index: number, side: string, reason = "理由") => `{"index":${index},"side":"${side}","reason":"${reason}"}`;
const wrap = (...items: string[]) => `{"decisions":[${items.join(",")}]}`;

suite("競合の判定の応答の検証", () => {
	test("二択の答えを読む", () => {
		const found = validateConflictResponse(wrap(ok(1, "ours"), ok(2, "theirs")), 2);

		assert.equal(found.decisions.length, 2);
		assert.equal(found.decisions[0].side, "ours");
		assert.equal(found.decisions[1].side, "theirs");
		assert.equal(found.discarded.length, 0);
	});

	test("コードフェンスに包まれていても読む", () => {
		const found = validateConflictResponse(`\`\`\`json\n${wrap(ok(1, "ours"))}\n\`\`\``, 1);

		assert.equal(found.decisions.length, 1);
	});

	test("前後に説明文が付いていても読む", () => {
		const found = validateConflictResponse(`考えました。\n${wrap(ok(1, "theirs"))}\n以上です。`, 1);

		assert.equal(found.decisions.length, 1);
	});

	test("JSON として読めなければ、1件も採らない", () => {
		const found = validateConflictResponse("すみません、判断できませんでした", 2);

		assert.equal(found.decisions.length, 0);
		assert.equal(found.discarded.length, 1);
	});

	test("decisions が無ければ、1件も採らない", () => {
		const found = validateConflictResponse('{"result":"ok"}', 2);

		assert.equal(found.decisions.length, 0);
	});

	suite("語彙の外は捨てる", () => {
		test("新しい訳を書いてきても採らない（二択しか許さない）", () => {
			// AI に値を作らせない。採否は人の宣言に留める（ADR-260911-02）
			const found = validateConflictResponse(wrap('{"index":1,"side":"merged","reason":"両方を合わせました"}'), 1);

			assert.equal(found.decisions.length, 0);
			assert.match(found.discarded[0], /unknown side/);
		});

		test("unsure は、決まらなかったこととして残す", () => {
			const found = validateConflictResponse(wrap(ok(1, "ours"), '{"index":2,"side":"unsure"}'), 2);

			assert.equal(found.decisions.length, 1);
			assert.match(found.discarded[0], /unsure/);
		});
	});

	suite("番号が合わない件は捨てる", () => {
		test("送っていない番号は採らない", () => {
			const found = validateConflictResponse(wrap(ok(1, "ours"), ok(9, "theirs")), 2);

			assert.equal(found.decisions.length, 1);
			assert.match(found.discarded[0], /outside 1\.\.2/);
		});

		test("0 や負の番号も採らない", () => {
			const found = validateConflictResponse(wrap(ok(0, "ours"), ok(-1, "theirs")), 2);

			assert.equal(found.decisions.length, 0);
		});

		test("同じ番号に2つ答えが来たら、どちらも採らない", () => {
			// どちらが正しいか分からないものを黙って採るより、決まらなかったことにする。
			// 先に来たほうを残すと、答えの順番だけで採否が決まってしまう
			const found = validateConflictResponse(wrap(ok(1, "ours"), ok(1, "theirs")), 1);

			assert.equal(found.decisions.length, 0, "先に来たほうが残っている");
			assert.match(found.discarded[0], /answered more than once/);
		});

		test("同じ番号が3つ来ても、捨てた理由は1つにまとめる", () => {
			const found = validateConflictResponse(wrap(ok(1, "ours"), ok(1, "theirs"), ok(1, "ours")), 1);

			assert.equal(found.decisions.length, 0);
			assert.equal(found.discarded.length, 1);
		});
	});

	test("説明文に別の波括弧が混ざっていても読める", () => {
		// 最初の `{` から最後の `}` まで切り出す形だと、この応答はまるごと読めなくなり、
		// 問い直しを1回無駄にしていた
		const found = validateConflictResponse(
			'考えたこと {補足: 用語集と照らした} 答えは次です {"decisions":[{"index":1,"side":"ours","reason":"用語集どおり"}]}',
			1,
		);

		assert.equal(found.unreadable, false);
		assert.equal(found.decisions.length, 1);
		assert.equal(found.decisions[0].side, "ours");
	});

	test("理由が無くても採る（理由は解説であって判定ではない）", () => {
		const found = validateConflictResponse(wrap('{"index":1,"side":"ours"}'), 1);

		assert.equal(found.decisions.length, 1);
		assert.equal(found.decisions[0].reason, "");
	});
});
