import * as assert from "node:assert";
import * as path from "node:path";
import { OperationRegistry } from "../../../../commands/shared/operation-registry";

const WS = path.resolve("/ws");
const FILE_A = path.join(WS, "docs", "ja", "a.md");
const FILE_B = path.join(WS, "docs", "ja", "b.md");
const DIR_JA = path.join(WS, "docs", "ja");

suite("OperationRegistry（実行中操作の台帳）", () => {
	setup(() => {
		OperationRegistry.dispose();
	});
	teardown(() => {
		OperationRegistry.dispose();
	});

	suite("多重起動の拒否", () => {
		test("同じファイルを処理中なら2回目の取得は断られる", () => {
			const registry = OperationRegistry.getInstance();
			const first = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			const second = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });

			assert.ok(first, "1回目は取得できること");
			assert.strictEqual(second, undefined, "2回目は断られること");
		});

		test("解放したあとは再び取得できる", () => {
			const registry = OperationRegistry.getInstance();
			const first = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			first?.release();

			const second = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			assert.ok(second, "解放後は取得できること");
		});

		test("解放を二重に呼んでも他の登録を壊さない", () => {
			const registry = OperationRegistry.getInstance();
			const a = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			a?.release();
			a?.release();
			const b = registry.acquire({ kind: "translate", scope: "file", path: FILE_B });

			assert.ok(b, "別ファイルは取得できること");
			assert.strictEqual(registry.size, 1, "登録数が1件であること");
		});

		test("ファイル翻訳中は同じファイルのユニット翻訳も断られる（ファイルは丸ごと読み書きされるため）", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			const unit = registry.acquire({
				kind: "translate",
				scope: "unit",
				path: FILE_A,
				unitHash: "aaaa1111",
			});

			assert.strictEqual(unit, undefined, "同じファイルのユニット翻訳は断られること");
		});

		test("ディレクトリ翻訳中は配下ファイルの翻訳も断られる", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "directory", path: DIR_JA });
			const file = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });

			assert.strictEqual(file, undefined, "配下ファイルの翻訳は断られること");
		});

		test("ファイル翻訳中は、それを含むディレクトリ翻訳も断られる", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			const dir = registry.acquire({ kind: "translate", scope: "directory", path: DIR_JA });

			assert.strictEqual(dir, undefined, "祖先ディレクトリの翻訳は断られること");
		});

		test("別のファイルなら同時に取得できる", () => {
			const registry = OperationRegistry.getInstance();
			const a = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			const b = registry.acquire({ kind: "translate", scope: "file", path: FILE_B });

			assert.ok(a && b, "別ファイルは並行して取得できること");
		});

		test("種類が違えば重ならない（翻訳中でも用語集更新は取得できる）", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			const terms = registry.acquire({ kind: "terms", scope: "file", path: FILE_A });

			assert.ok(terms, "種類が違えば取得できること");
		});

		test("似た名前のディレクトリを取り違えない（docs/ja と docs/ja-JP）", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "directory", path: DIR_JA });
			const other = registry.acquire({
				kind: "translate",
				scope: "file",
				path: path.join(WS, "docs", "ja-JP", "a.md"),
			});

			assert.ok(other, "別ディレクトリ配下は断られないこと");
		});
	});

	suite("処理中の見え方", () => {
		test("登録していない対象は処理中に見えない", () => {
			const registry = OperationRegistry.getInstance();
			assert.strictEqual(registry.isBusy({ scope: "file", path: FILE_A }), false);
		});

		test("解放すると処理中の表示が必ず消える", () => {
			const registry = OperationRegistry.getInstance();
			const handle = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			assert.strictEqual(registry.isBusy({ scope: "file", path: FILE_A }), true);

			handle?.release();
			assert.strictEqual(
				registry.isBusy({ scope: "file", path: FILE_A }),
				false,
				"解放後は処理中に見えないこと",
			);
		});

		test("ユニット翻訳中は親ファイルも処理中に見える", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({
				kind: "translate",
				scope: "unit",
				path: FILE_A,
				unitHash: "aaaa1111",
			});

			assert.strictEqual(registry.isBusy({ scope: "file", path: FILE_A }), true);
			assert.strictEqual(registry.isBusy({ scope: "directory", path: DIR_JA }), true);
		});

		test("ユニット翻訳中でも、同じファイルの別ユニットは処理中に見えない", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({
				kind: "translate",
				scope: "unit",
				path: FILE_A,
				unitHash: "aaaa1111",
			});

			assert.strictEqual(
				registry.isBusy({ scope: "unit", path: FILE_A, unitHash: "bbbb2222" }),
				false,
			);
		});

		test("ファイル翻訳中でも、着手していないユニットは処理中に見えない", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "file", path: FILE_A });

			assert.strictEqual(
				registry.isBusy({ scope: "unit", path: FILE_A, unitHash: "bbbb2222" }),
				false,
				"ファイルの登録から配下ユニットを推測しないこと（全ユニットが同時に回るのを防ぐ）",
			);
		});

		test("ファイル翻訳中に処理中として登録したユニットだけが処理中に見える", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			const first = registry.track({
				kind: "translate",
				scope: "unit",
				path: FILE_A,
				unitHash: "aaaa1111",
			});

			assert.strictEqual(
				registry.isBusy({ scope: "unit", path: FILE_A, unitHash: "aaaa1111" }),
				true,
			);
			assert.strictEqual(
				registry.isBusy({ scope: "unit", path: FILE_A, unitHash: "bbbb2222" }),
				false,
			);

			// 1件目を終えて2件目へ進む
			first.release();
			registry.track({
				kind: "translate",
				scope: "unit",
				path: FILE_A,
				unitHash: "bbbb2222",
			});

			assert.strictEqual(
				registry.isBusy({ scope: "unit", path: FILE_A, unitHash: "aaaa1111" }),
				false,
				"訳し終えたユニットは処理中に見えないこと",
			);
			assert.strictEqual(
				registry.isBusy({ scope: "unit", path: FILE_A, unitHash: "bbbb2222" }),
				true,
			);
		});

		test("frontmatter 行は frontmatter を訳している間だけ処理中に見える", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "file", path: FILE_A });

			assert.strictEqual(
				registry.isBusy({ scope: "frontmatter", path: FILE_A }),
				false,
				"ファイル翻訳中というだけでは frontmatter 行は回らないこと",
			);

			const handle = registry.track({ kind: "translate", scope: "frontmatter", path: FILE_A });
			assert.strictEqual(registry.isBusy({ scope: "frontmatter", path: FILE_A }), true);

			handle.release();
			assert.strictEqual(registry.isBusy({ scope: "frontmatter", path: FILE_A }), false);
		});

		test("ディレクトリ翻訳中でも、着手していないファイルは処理中に見えない", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "directory", path: DIR_JA });

			assert.strictEqual(registry.isBusy({ scope: "directory", path: DIR_JA }), true);
			assert.strictEqual(
				registry.isBusy({ scope: "file", path: FILE_A }),
				false,
				"ディレクトリの登録から配下ファイルを推測しないこと",
			);
		});

		test("ディレクトリ翻訳中は、処理中のファイルとその祖先ディレクトリが処理中に見える", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "translate", scope: "directory", path: DIR_JA });
			const handle = registry.track({ kind: "translate", scope: "file", path: FILE_A });

			assert.strictEqual(registry.isBusy({ scope: "file", path: FILE_A }), true);
			assert.strictEqual(registry.isBusy({ scope: "file", path: FILE_B }), false);
			assert.strictEqual(registry.isBusy({ scope: "directory", path: DIR_JA }), true);

			handle.release();
			assert.strictEqual(
				registry.isBusy({ scope: "file", path: FILE_A }),
				false,
				"訳し終えたファイルは処理中に見えないこと",
			);
			assert.strictEqual(
				registry.isBusy({ scope: "directory", path: DIR_JA }),
				true,
				"ディレクトリ操作そのものは続いているので回り続けること",
			);
		});

		test("表示専用の登録は多重起動の判定に混ざらない", () => {
			const registry = OperationRegistry.getInstance();
			registry.track({ kind: "translate", scope: "file", path: FILE_A });

			const acquired = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			assert.ok(acquired, "表示専用の登録が排他の根拠にならないこと");
		});

		test("表示は種類を問わない（用語集更新中もファイル行は処理中に見える）", () => {
			const registry = OperationRegistry.getInstance();
			registry.acquire({ kind: "terms", scope: "file", path: FILE_A });

			assert.strictEqual(registry.isBusy({ scope: "file", path: FILE_A }), true);
		});
	});

	suite("変更通知", () => {
		test("登録と解放のたびに通知される（表示の更新のため）", () => {
			const registry = OperationRegistry.getInstance();
			let count = 0;
			registry.onChanged(() => {
				count++;
			});

			const handle = registry.acquire({ kind: "translate", scope: "file", path: FILE_A });
			assert.strictEqual(count, 1, "登録で1回通知されること");

			handle?.release();
			assert.strictEqual(count, 2, "解放で1回通知されること");
		});
	});
});
