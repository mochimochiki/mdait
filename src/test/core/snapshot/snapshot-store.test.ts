import { strict as assert } from "node:assert";
import { SnapshotParseError, SnapshotStore, getBucketId } from "../../../core/snapshot/snapshot-store";

suite("SnapshotStore", () => {
	suite("getBucketId", () => {
		test("ハッシュの先頭3桁を小文字で返す", () => {
			assert.equal(getBucketId("abc12345"), "abc");
			assert.equal(getBucketId("ABC12345"), "abc");
			assert.equal(getBucketId("00012345"), "000");
			assert.equal(getBucketId("fff12345"), "fff");
		});
	});

	suite("upsert / get", () => {
		test("エントリを追加して取得できる", () => {
			const store = new SnapshotStore();
			store.upsert("abc12345", "content1");

			assert.equal(store.get("abc12345"), "content1");
		});

		test("大文字小文字を正規化して扱う", () => {
			const store = new SnapshotStore();
			store.upsert("ABC12345", "content1");

			assert.equal(store.get("abc12345"), "content1");
			assert.equal(store.get("ABC12345"), "content1");
		});

		test("存在しないハッシュはnullを返す", () => {
			const store = new SnapshotStore();

			assert.equal(store.get("abc12345"), null);
		});

		test("upsertで既存エントリを上書きできる", () => {
			const store = new SnapshotStore();
			store.upsert("abc12345", "content1");
			store.upsert("abc12345", "content2");

			assert.equal(store.get("abc12345"), "content2");
		});
	});

	suite("upsertMany", () => {
		test("複数エントリを一括追加できる", () => {
			const store = new SnapshotStore();
			store.upsertMany([
				["abc12345", "content1"],
				["def67890", "content2"],
				["abc54321", "content3"],
			]);

			assert.equal(store.get("abc12345"), "content1");
			assert.equal(store.get("def67890"), "content2");
			assert.equal(store.get("abc54321"), "content3");
		});
	});

	suite("serialize", () => {
		test("全バケット（000〜fff）が出力され、エントリはバケット内で昇順", () => {
			const store = new SnapshotStore();
			// 逆順で追加
			store.upsert("fff00001", "contentF");
			store.upsert("abc00002", "contentA2");
			store.upsert("abc00001", "contentA1");
			store.upsert("000fffff", "content0");

			const result = store.serialize();
			const lines = result.split("\n");

			// 全4096バケットが出力される
			assert.equal(lines.length, 4096 + 4); // 4096バケット行 + 4エントリ

			// 000バケットとそのエントリ
			assert.equal(lines[0], "000 ");
			assert.equal(lines[1], "000fffff content0");

			// 001〜abaバケットは空（バケット行のみ）
			assert.equal(lines[2], "001 ");

			// abcバケット（0xabc = 2748、000からの行オフセットを計算）
			// 000バケット+1エントリ = 2行、001〜abb = 2747行、abc = 2749行目（インデックス2748+1=2749）
			// しかし000にエントリがあるので、001は index 2
			// abcは 0xabc = 2748番目のバケット
			// 000(+1entry)=2行、001〜aba=2747行、合計2749行目がabcバケット行
			const abcBucketIndex = 1 + 1 + 2747; // 000行 + 000エントリ + (001〜aba)
			assert.equal(lines[abcBucketIndex], "abc ");
			assert.equal(lines[abcBucketIndex + 1], "abc00001 contentA1");
			assert.equal(lines[abcBucketIndex + 2], "abc00002 contentA2");
		});

		test("空のストアでも全バケット行が出力される", () => {
			const store = new SnapshotStore();
			const result = store.serialize();
			const lines = result.split("\n");

			// 全4096バケット行
			assert.equal(lines.length, 4096);
			assert.equal(lines[0], "000 ");
			assert.equal(lines[4095], "fff ");
		});

		test("決定論的出力: 同じ入力からは同じ出力", () => {
			const entries: [string, string][] = [
				["abc12345", "content1"],
				["def67890", "content2"],
				["abc54321", "content3"],
				["12345678", "content4"],
			];

			const store1 = new SnapshotStore();
			const store2 = new SnapshotStore();

			// 異なる順序で追加
			store1.upsertMany(entries);
			store2.upsertMany([...entries].reverse());

			assert.equal(store1.serialize(), store2.serialize());
		});
	});

	suite("parse", () => {
		test("正しい形式をパースできる", () => {
			const content = `000 
000fffff content0
abc 
abc00001 contentA1
abc00002 contentA2`;

			const store = new SnapshotStore();
			store.parse(content);

			assert.equal(store.get("000fffff"), "content0");
			assert.equal(store.get("abc00001"), "contentA1");
			assert.equal(store.get("abc00002"), "contentA2");
		});

		test("空のコンテンツをパースできる", () => {
			const store = new SnapshotStore();
			store.parse("");

			assert.equal(store.size(), 0);
		});

		test("空白行を含むコンテンツをパースできる", () => {
			const content = `000 
000fffff content0

abc 
abc00001 contentA1
`;

			const store = new SnapshotStore();
			store.parse(content);

			assert.equal(store.get("000fffff"), "content0");
			assert.equal(store.get("abc00001"), "contentA1");
		});

		test("バケット行なしでエントリが出現するとエラー", () => {
			const content = `abc00001 contentA1`;

			const store = new SnapshotStore();
			assert.throws(() => store.parse(content), SnapshotParseError);
		});

		test("ハッシュが間違ったバケットにあるとエラー", () => {
			const content = `000 
abc00001 contentA1`;

			const store = new SnapshotStore();
			assert.throws(() => store.parse(content), SnapshotParseError);
		});

		test("重複ハッシュがあるとエラー", () => {
			const content = `abc 
abc00001 content1
abc00001 content2`;

			const store = new SnapshotStore();
			assert.throws(() => store.parse(content), SnapshotParseError);
		});
	});

	suite("parse → serialize ラウンドトリップ", () => {
		test("パースしてシリアライズするとエントリが保持される", () => {
			const original = `000 
000fffff content0
abc 
abc00001 contentA1
abc00002 contentA2
fff 
fff12345 contentF`;

			const store = new SnapshotStore();
			store.parse(original);
			const result = store.serialize();

			// シリアライズ後は全バケットが出力されるため、元とは異なる
			// ただしエントリは保持される
			assert.equal(store.get("000fffff"), "content0");
			assert.equal(store.get("abc00001"), "contentA1");
			assert.equal(store.get("abc00002"), "contentA2");
			assert.equal(store.get("fff12345"), "contentF");

			// 再パースしても同じ
			const store2 = new SnapshotStore();
			store2.parse(result);
			assert.equal(store2.get("000fffff"), "content0");
		});
	});

	suite("retainOnly (GC)", () => {
		test("指定したハッシュのみを残す", () => {
			const store = new SnapshotStore();
			store.upsertMany([
				["abc12345", "content1"],
				["abc54321", "content2"],
				["def67890", "content3"],
			]);

			store.retainOnly(new Set(["abc12345", "def67890"]));

			assert.equal(store.get("abc12345"), "content1");
			assert.equal(store.get("abc54321"), null);
			assert.equal(store.get("def67890"), "content3");
			assert.equal(store.size(), 2);
		});

		test("大文字小文字を正規化して比較する", () => {
			const store = new SnapshotStore();
			store.upsert("abc12345", "content1");

			store.retainOnly(new Set(["ABC12345"]));

			assert.equal(store.get("abc12345"), "content1");
		});

		test("GC後もバケット行は全て出力される", () => {
			const store = new SnapshotStore();
			store.upsertMany([
				["abc12345", "content1"],
				["def67890", "content2"],
			]);

			store.retainOnly(new Set(["abc12345"]));

			const result = store.serialize();
			// defバケット行は存在するが、エントリはない
			assert.ok(result.includes("def "));
			assert.ok(!result.includes("def67890"));
		});
	});

	suite("size / keys / clear", () => {
		test("sizeはエントリ数を返す", () => {
			const store = new SnapshotStore();
			assert.equal(store.size(), 0);

			store.upsert("abc12345", "content1");
			assert.equal(store.size(), 1);

			store.upsert("def67890", "content2");
			assert.equal(store.size(), 2);
		});

		test("keysはすべてのハッシュを返す", () => {
			const store = new SnapshotStore();
			store.upsertMany([
				["abc12345", "content1"],
				["def67890", "content2"],
			]);

			const keys = store.keys();
			assert.equal(keys.length, 2);
			assert.ok(keys.includes("abc12345"));
			assert.ok(keys.includes("def67890"));
		});

		test("clearはストアを空にする", () => {
			const store = new SnapshotStore();
			store.upsert("abc12345", "content1");
			store.clear();

			assert.equal(store.size(), 0);
			assert.equal(store.get("abc12345"), null);
		});
	});

	suite("パフォーマンス", () => {
		test("200エントリの一括更新が現実的な時間で完了する", () => {
			const store = new SnapshotStore();

			// 200エントリを生成
			const entries: [string, string][] = [];
			for (let i = 0; i < 200; i++) {
				const hash = i.toString(16).padStart(8, "0");
				entries.push([hash, `content_${i}`]);
			}

			const start = Date.now();
			store.upsertMany(entries);
			const serialized = store.serialize();
			store.parse(serialized);
			const elapsed = Date.now() - start;

			assert.equal(store.size(), 200);
			// 100ms以内で完了すること
			assert.ok(elapsed < 100, `Elapsed: ${elapsed}ms should be < 100ms`);
		});
	});
});
