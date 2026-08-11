// sync の「ふつうと違うできごと」の伝え方（何本のトーストを出すか）の検証。
//
// 1本ずつはどれも ux.md §3.3 の「通知に載せてよいのは実行の結果と次の一手」に適う。
// 破れるのは重なったときだけで、同じ §3.3 の「変化の気づきは1箇所に集約する」に反する。
// 完了サマリと合わせて最大6本が積み上がると、どれも読まれない。

import * as assert from "node:assert";
import { type SyncNotice, showSyncNotices } from "../../../../commands/sync/sync-notices";

declare let __vscodeMockShownMessages: Array<{ level: string; message: string; items: string[] }>;
declare let __vscodeMockMessageChoice: string | undefined;

function notice(kind: string, action?: { label: string; run: () => undefined }): SyncNotice {
	return {
		kind,
		detail: `${kind} の詳しい説明。なぜ起きたか、次に何をすればよいか。`,
		summary: `${kind} が 1 件`,
		...(action ? { action } : {}),
	};
}

/** 出したトーストが処理されるまで待つ（fire-and-forget なので1周回す） */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

suite("showSyncNotices（sync のできごとの伝え方）", () => {
	setup(() => {
		__vscodeMockShownMessages = [];
		__vscodeMockMessageChoice = undefined;
	});

	teardown(() => {
		__vscodeMockShownMessages = [];
		__vscodeMockMessageChoice = undefined;
	});

	test("できごとが無ければ何も出さないこと", async () => {
		showSyncNotices([]);
		await settle();

		assert.strictEqual(__vscodeMockShownMessages.length, 0);
	});

	test("1件なら、そのできごとの説明と導線をそのまま出すこと", async () => {
		// 普段の運用では1件しか起きない。見え方は従来と変わらない
		showSyncNotices([notice("source-emptied", { label: "How to restore", run: () => undefined })]);
		await settle();

		assert.strictEqual(__vscodeMockShownMessages.length, 1);
		const shown = __vscodeMockShownMessages[0];
		assert.strictEqual(shown.level, "warning");
		assert.ok(shown.message.includes("次に何をすればよいか"), "詳しい説明が出る");
		assert.deepStrictEqual(shown.items, ["How to restore"], "そのできごとに合った導線が出る");
	});

	test("1件でボタンが無いできごとは、ボタン無しで出すこと", async () => {
		showSyncNotices([notice("target-emptied")]);
		await settle();

		assert.strictEqual(__vscodeMockShownMessages.length, 1);
		assert.deepStrictEqual(__vscodeMockShownMessages[0].items, []);
	});

	test("2件以上でも、トーストは1本にまとまること", async () => {
		showSyncNotices([
			notice("deletion-withheld", { label: "Show units", run: () => undefined }),
			notice("source-emptied", { label: "How to restore", run: () => undefined }),
			notice("new-orphans", { label: "Show in mdait", run: () => undefined }),
		]);
		await settle();

		assert.strictEqual(__vscodeMockShownMessages.length, 1, "3本ではなく1本");
	});

	test("まとめたトーストに、すべてのできごとが1行ずつ載ること", async () => {
		showSyncNotices([notice("deletion-withheld"), notice("new-orphans")]);
		await settle();

		const message = __vscodeMockShownMessages[0].message;
		assert.ok(message.includes("deletion-withheld が 1 件"), "1件目が載る");
		assert.ok(message.includes("new-orphans が 1 件"), "2件目が載る");
		assert.ok(!message.includes("次に何をすればよいか"), "長い説明は載せない（1行に絞る）");
	});

	test("まとめたトーストのボタンは1つに絞ること", async () => {
		// 「同じ重みのボタンを3つ以上並べない。主導線は1つに絞る」（ux.md §3.3）
		showSyncNotices([
			notice("deletion-withheld", { label: "Show units", run: () => undefined }),
			notice("source-emptied", { label: "How to restore", run: () => undefined }),
			notice("orphan-deleted", { label: "How to restore", run: () => undefined }),
		]);
		await settle();

		assert.strictEqual(__vscodeMockShownMessages[0].items.length, 1, "導線は1つ");
	});

	test("5件すべてが起きても1本に収まること", async () => {
		// 従来はここで5本が積み上がり、完了サマリと合わせて6本になっていた
		showSyncNotices([
			notice("deletion-withheld"),
			notice("source-emptied"),
			notice("target-emptied"),
			notice("new-orphans"),
			notice("orphan-deleted"),
		]);
		await settle();

		assert.strictEqual(__vscodeMockShownMessages.length, 1);
	});

	test("1件のときにボタンを押すと、そのできごとの処理が走ること", async () => {
		let ran = false;
		__vscodeMockMessageChoice = "Show units";
		showSyncNotices([
			notice("deletion-withheld", {
				label: "Show units",
				run: () => {
					ran = true;
					return undefined;
				},
			}),
		]);
		await settle();

		assert.strictEqual(ran, true);
	});

	test("押されたボタンが違えば処理は走らないこと", async () => {
		let ran = false;
		__vscodeMockMessageChoice = undefined; // 閉じられた
		showSyncNotices([
			notice("deletion-withheld", {
				label: "Show units",
				run: () => {
					ran = true;
					return undefined;
				},
			}),
		]);
		await settle();

		assert.strictEqual(ran, false);
	});
});
