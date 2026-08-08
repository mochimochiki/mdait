/**
 * 「新しく孤立した訳文があるときだけ通知する」記憶のテスト（ADR-260806-01）。
 *
 * 孤立は人が片付けるまで続く状態なので毎回言うと通知疲れになる。逆に黙りきると、
 * リネームという能動的な操作の直後に何も言われず、原因と結果が結びつかない。
 */

import * as assert from "node:assert";
import { resetOrphanMemory, updateOrphanMemory } from "../../../../commands/sync/sync-command";

/** 判定の対象にしたパス（この範囲の外は記憶を触らない） */
function scope(...paths: string[]): Set<string> {
	return new Set(paths);
}

suite("sync: 孤立訳文の通知記憶", () => {
	setup(() => {
		resetOrphanMemory();
	});

	teardown(() => {
		resetOrphanMemory();
	});

	test("初めて孤立したものだけを返すこと", () => {
		const fresh = updateOrphanMemory(new Set(["en/a.md"]), scope("en/a.md", "en/b.md"));
		assert.deepStrictEqual(fresh, ["en/a.md"]);
	});

	test("同じ孤立が続くあいだは黙ること", () => {
		updateOrphanMemory(new Set(["en/a.md"]), scope("en/a.md"));
		const again = updateOrphanMemory(new Set(["en/a.md"]), scope("en/a.md"));
		assert.deepStrictEqual(again, []);
	});

	test("1件解消して1件発生したときに黙らないこと（件数では数えない）", () => {
		updateOrphanMemory(new Set(["en/a.md"]), scope("en/a.md", "en/b.md"));
		const fresh = updateOrphanMemory(new Set(["en/b.md"]), scope("en/a.md", "en/b.md"));
		assert.deepStrictEqual(fresh, ["en/b.md"], "件数は1のままでも新しい孤立は伝える");
	});

	test("解消したものは忘れ、再び孤立したらまた伝えること", () => {
		updateOrphanMemory(new Set(["en/a.md"]), scope("en/a.md"));
		updateOrphanMemory(new Set<string>(), scope("en/a.md"));
		const again = updateOrphanMemory(new Set(["en/a.md"]), scope("en/a.md"));
		assert.deepStrictEqual(again, ["en/a.md"], "2度目の事故でも黙らない");
	});

	test("今回見ていない範囲のものは解消と読み違えないこと", () => {
		updateOrphanMemory(new Set(["fr/a.md"]), scope("fr/a.md"));
		// fr を選択から外して sync（判定の対象に入っていない）
		updateOrphanMemory(new Set<string>(), scope("en/a.md"));
		const again = updateOrphanMemory(new Set(["fr/a.md"]), scope("fr/a.md"));
		assert.deepStrictEqual(again, [], "見ていない間に忘れていないこと");
	});
});
