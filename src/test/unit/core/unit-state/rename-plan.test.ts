import * as assert from "node:assert";
import {
	type PathRename,
	type RenameFollowProbe,
	planEntryMoves,
	planRenameFollow,
} from "../../../../core/unit-state/rename-plan";

/**
 * テスト用の probe。
 *
 * `pairs` は「原文ディレクトリ → 訳文ディレクトリ」の対応表で、`FileExplorer` の
 * 実装（前方一致でディレクトリ配下を判定し、相対パスを付け替える）を最小限になぞる。
 * パスは `/` 区切りの相対表記で書く。
 */
function probeOf(pairs: Array<[string, string]>, existing: string[], known: string[] = []): RenameFollowProbe {
	const present = new Set(existing);
	const knownPaths = new Set(known);
	const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
	const swapDir = (p: string, from: string, to: string) => (p === from ? to : `${to}/${p.substring(from.length + 1)}`);
	return {
		deriveTargetRenames(rename: PathRename): PathRename[] {
			const derived: PathRename[] = [];
			for (const [sourceDir, targetDir] of pairs) {
				if (!under(rename.oldPath, sourceDir)) {
					continue;
				}
				if (!under(rename.newPath, sourceDir)) {
					continue; // 移動先が原文ディレクトリの外。訳文の行き先を導けない
				}
				derived.push({
					oldPath: swapDir(rename.oldPath, sourceDir, targetDir),
					newPath: swapDir(rename.newPath, sourceDir, targetDir),
				});
			}
			return derived;
		},
		exists: (p) => present.has(p),
		hasEntriesAt: (p) => [...knownPaths].some((k) => k === p || k.startsWith(`${p}/`)),
		sameKey: (p) => p,
	};
}

const JA_EN: Array<[string, string]> = [["content/ja", "content/en"]];
const PIVOT: Array<[string, string]> = [
	["content/ja", "content/en"],
	["content/en", "content/fr"],
];

suite("移動の前に立てる計画（連れて動かす訳文）", () => {
	test("原文を動かすと、対応する訳文を連れて動かすこと", () => {
		const probe = probeOf(JA_EN, ["content/ja/guide.md", "content/en/guide.md"]);
		const plan = planRenameFollow([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(plan.companions, [{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" }]);
		assert.deepStrictEqual(plan.blocked, []);
	});

	test("訳文だけを動かしたときは原文に手を出さないこと（原文が正・訳文が従）", () => {
		const probe = probeOf(JA_EN, ["content/ja/guide.md", "content/en/guide.md"]);
		const plan = planRenameFollow([{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" }], probe);

		assert.deepStrictEqual(plan.companions, []);
	});

	test("訳文がまだ無ければ連れて行かないこと（sync が原文から作る）", () => {
		const probe = probeOf(JA_EN, ["content/ja/guide.md"]);
		const plan = planRenameFollow([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(plan.companions, []);
		assert.deepStrictEqual(plan.blocked, [], "無いものは「連れて行けなかった」でもないこと");
	});

	test("ユーザーが原文と訳文を両方まとめて動かしたときに、訳文を二重に動かさないこと", () => {
		const probe = probeOf(JA_EN, ["content/ja/guide.md", "content/en/guide.md"]);
		const plan = planRenameFollow(
			[
				{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" },
				{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" },
			],
			probe,
		);

		assert.deepStrictEqual(plan.companions, []);
	});

	test("行き先が塞がっている訳文は連れて行かず、理由を残すこと", () => {
		// 上書きで移すと別の訳文がごみ箱も経由せず消える。連れて行かなかった訳文は
		// 原文を失うので、段階1の孤立としてツリーに出る
		const probe = probeOf(JA_EN, ["content/ja/guide.md", "content/en/guide.md", "content/en/handbook.md"]);
		const plan = planRenameFollow([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(plan.companions, []);
		assert.deepStrictEqual(plan.blocked, [
			{
				rename: { oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" },
				reason: "destination-exists",
			},
		]);
	});

	test("ピボット構成（ja→en, en→fr）で、連鎖する訳文も連れて動かすこと", () => {
		// en/x.md を連れて動かしたところで止めると、fr/x.md だけが取り残されて
		// 新しい孤立を作る（段階1のレビューで見つかった筋書きと同じ構造）
		const probe = probeOf(PIVOT, ["content/ja/guide.md", "content/en/guide.md", "content/fr/guide.md"]);
		const plan = planRenameFollow([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(plan.companions, [
			{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" },
			{ oldPath: "content/fr/guide.md", newPath: "content/fr/handbook.md" },
		]);
	});

	test("1つの原文に複数言語の訳文があれば、その全部を連れて動かすこと", () => {
		const probe = probeOf(
			[
				["content/ja", "content/en"],
				["content/ja", "content/fr"],
			],
			["content/ja/guide.md", "content/en/guide.md", "content/fr/guide.md"],
		);
		const plan = planRenameFollow([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(plan.companions, [
			{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" },
			{ oldPath: "content/fr/guide.md", newPath: "content/fr/handbook.md" },
		]);
	});

	test("フォルダごと動かすときも、対応するフォルダを連れて動かすこと", () => {
		// フォルダの移動はイベント1件でファイルが何十件も動く。ディレクトリを
		// ディレクトリのまま扱えないと、この形は受け取れない
		const probe = probeOf(JA_EN, ["content/ja/sub", "content/en/sub"]);
		const plan = planRenameFollow([{ oldPath: "content/ja/sub", newPath: "content/ja/moved" }], probe);

		assert.deepStrictEqual(plan.companions, [{ oldPath: "content/en/sub", newPath: "content/en/moved" }]);
	});

	test("原文を管理外へ動かしたときは連れて行かないこと（訳文の行き先が無い）", () => {
		const probe = probeOf(JA_EN, ["content/ja/guide.md", "content/en/guide.md"]);
		const plan = planRenameFollow([{ oldPath: "content/ja/guide.md", newPath: "archive/guide.md" }], probe);

		assert.deepStrictEqual(plan.companions, []);
	});

	test("移動が無ければ何も計画しないこと", () => {
		const plan = planRenameFollow([], probeOf(JA_EN, []));
		assert.deepStrictEqual(plan, { companions: [], blocked: [] });
	});
});

suite("移動のあとに立てる計画（unit-state の行の付け替え）", () => {
	test("連れて動いた訳文の行も一緒に付け替えること", () => {
		// 移動後の世界。原文も訳文も新しいパスに居る
		const probe = probeOf(JA_EN, ["content/ja/handbook.md", "content/en/handbook.md"]);
		const moves = planEntryMoves([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(moves, [
			{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" },
			{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" },
		]);
	});

	test("訳文が旧パスに残っているなら行も残すこと（連れて行けなかった場合）", () => {
		// 行き先が塞がっていて訳文を動かせなかった世界
		const probe = probeOf(JA_EN, ["content/ja/handbook.md", "content/en/guide.md", "content/en/handbook.md"]);
		const moves = planEntryMoves([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(moves, [{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }]);
	});

	test("取り消しで巻き戻ったときも実態どおりに戻すこと", () => {
		// Ctrl+Z で原文も訳文も元の場所へ戻った世界。報せに訳文が並んでいなくても、
		// 実測なら訳文の行も一緒に戻る（控えに頼っていると、ここで取り残される）
		const probe = probeOf(JA_EN, ["content/ja/guide.md", "content/en/guide.md"]);
		const moves = planEntryMoves([{ oldPath: "content/ja/handbook.md", newPath: "content/ja/guide.md" }], probe);

		assert.deepStrictEqual(moves, [
			{ oldPath: "content/ja/handbook.md", newPath: "content/ja/guide.md" },
			{ oldPath: "content/en/handbook.md", newPath: "content/en/guide.md" },
		]);
	});

	test("ユーザーが原文と訳文を両方動かしたときに、同じ移動を二度並べないこと", () => {
		const probe = probeOf(JA_EN, ["content/ja/handbook.md", "content/en/handbook.md"]);
		const moves = planEntryMoves(
			[
				{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" },
				{ oldPath: "content/en/guide.md", newPath: "content/en/handbook.md" },
			],
			probe,
		);

		assert.strictEqual(moves.length, 2);
	});

	test("行き先に別の訳文の行が既にあるなら、導いた付け替えを見送ること", () => {
		// 移動前から `content/en/handbook.md` が在り（訳し終えた別の文書）、
		// `content/en/guide.md` は以前に消されているが行だけ残っている、という世界。
		// 「旧パスに無く・新パスに在る」は満たしてしまうので、実在だけを見ていると
		// 移動していないものを移動と誤認し、`movePath` が行き先の行を先に全消しする。
		// mdait が既に知っている訳文は、いまの移動で生まれたものではない
		const probe = probeOf(
			JA_EN,
			["content/ja/handbook.md", "content/en/handbook.md"],
			["content/en/guide.md", "content/en/handbook.md"],
		);
		const moves = planEntryMoves([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(
			moves,
			[{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }],
			"ユーザー自身の移動だけが残ること",
		);
	});

	test("ユーザー自身の移動は、行き先に行があっても含めること", () => {
		// 上書きを伴うリネームはユーザーが選んだ結果なので、行もそれに従う。
		// 見送ってよいのは、こちらが勝手に導いた訳文の付け替えだけである
		const probe = probeOf(JA_EN, ["content/ja/handbook.md"], ["content/ja/handbook.md"]);
		const moves = planEntryMoves([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(moves, [{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }]);
	});

	test("管理下でないファイルの移動でも、行の付け替えは試みること", () => {
		// 行が無ければ書き換え側が何もしないだけで済む。ここで素性を判定して
		// 間引くと、判定の取りこぼしがそのまま状態の取りこぼしになる
		const probe = probeOf(JA_EN, ["docs/README.md"]);
		const moves = planEntryMoves([{ oldPath: "README.md", newPath: "docs/README.md" }], probe);

		assert.deepStrictEqual(moves, [{ oldPath: "README.md", newPath: "docs/README.md" }]);
	});

	test("ピボット構成では、連鎖して動いた訳文の行まで付け替えること", () => {
		const probe = probeOf(PIVOT, ["content/ja/handbook.md", "content/en/handbook.md", "content/fr/handbook.md"]);
		const moves = planEntryMoves([{ oldPath: "content/ja/guide.md", newPath: "content/ja/handbook.md" }], probe);

		assert.deepStrictEqual(
			moves.map((m) => m.newPath),
			["content/ja/handbook.md", "content/en/handbook.md", "content/fr/handbook.md"],
		);
	});
});
