import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuditLedgerEntry,
	ledgerKey,
	parseAuditLedger,
	serializeAuditLedger,
} from "../../../../core/audit-ledger/audit-ledger-encoder";
import { AuditLedgerStore } from "../../../../core/audit-ledger/audit-ledger-store";

function entry(targetHash: string, fromHash: string, note = "", verdict = "flagged", acceptedAt = ""): AuditLedgerEntry {
	return { targetHash, fromHash, verdict, acceptedAt, note };
}

suite("audit-ledger encoder（受理台帳のシリアライズ）", () => {
	test("serialize → parse のラウンドトリップでエントリが保存される", () => {
		const entries = [
			entry("aaaa1111", "bbbb2222", "意図的に要約", "partial", "2026-07-07T00:00:00.000Z"),
			entry("cccc3333", "dddd4444", "追記あり", "mismatch", "2026-07-07T01:00:00.000Z"),
		];
		const text = serializeAuditLedger(entries);
		const parsed = parseAuditLedger(text);
		assert.strictEqual(parsed.size, 2);
		assert.deepStrictEqual(parsed.get(ledgerKey("aaaa1111", "bbbb2222")), entries[0]);
		assert.deepStrictEqual(parsed.get(ledgerKey("cccc3333", "dddd4444")), entries[1]);
	});

	test("シリアライズは targetHash → fromHash 昇順で決定的", () => {
		const a = serializeAuditLedger([
			entry("ffff0000", "1111aaaa"),
			entry("0000ffff", "2222bbbb"),
			entry("0000ffff", "1111aaaa"),
		]);
		const b = serializeAuditLedger([
			entry("0000ffff", "1111aaaa"),
			entry("ffff0000", "1111aaaa"),
			entry("0000ffff", "2222bbbb"),
		]);
		assert.strictEqual(a, b);
		const bodyLines = a.split("\n").filter((l) => l && !l.startsWith("#"));
		assert.deepStrictEqual(bodyLines, [
			"0000ffff\t1111aaaa\tflagged\t\t",
			"0000ffff\t2222bbbb\tflagged\t\t",
			"ffff0000\t1111aaaa\tflagged\t\t",
		]);
	});

	test("note のタブ・改行・バックスラッシュはエスケープされラウンドトリップする", () => {
		const note = "line1\tcol\nline2 \\ end";
		const text = serializeAuditLedger([entry("aaaa1111", "bbbb2222", note)]);
		// 1エントリ=1行（改行が生の改行として漏れない）
		assert.strictEqual(text.split("\n").filter((l) => l && !l.startsWith("#")).length, 1);
		const parsed = parseAuditLedger(text);
		assert.strictEqual(parsed.get(ledgerKey("aaaa1111", "bbbb2222"))?.note, note);
	});

	test("空行・コメント行・列数不一致・hash欠落の行はスキップされる", () => {
		const text = [
			"# header comment",
			"",
			"aaaa1111\tbbbb2222\tpartial\t\tok", // valid
			"too\tfew\tcols", // 3 cols → skip
			"\tbbbb2222\tflagged\t\tnote", // empty targetHash → skip
			"garbage line without tabs",
		].join("\n");
		const parsed = parseAuditLedger(text);
		assert.strictEqual(parsed.size, 1);
		assert.strictEqual(parsed.get(ledgerKey("aaaa1111", "bbbb2222"))?.note, "ok");
	});

	test("空文字列は空の Map を返す", () => {
		assert.strictEqual(parseAuditLedger("").size, 0);
		assert.strictEqual(parseAuditLedger("   \n\n").size, 0);
	});
});

suite("AuditLedgerStore（受理台帳ストア）", () => {
	let tempDir: string;

	setup(() => {
		AuditLedgerStore.dispose();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdait-ledger-"));
	});

	teardown(() => {
		AuditLedgerStore.dispose();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test("シングルトンで dispose によりリセットされる", () => {
		const a = AuditLedgerStore.getInstance();
		assert.strictEqual(a, AuditLedgerStore.getInstance());
		AuditLedgerStore.dispose();
		assert.notStrictEqual(a, AuditLedgerStore.getInstance());
	});

	test("ファイルが無くても load が成功し空になる", () => {
		const store = AuditLedgerStore.getInstance();
		store.load(tempDir);
		assert.deepStrictEqual(store.getAllEntries(), []);
		assert.strictEqual(store.isAccepted("aaaa1111", "bbbb2222"), false);
	});

	test("setEntry → save → 再 load で永続化される", () => {
		const store = AuditLedgerStore.getInstance();
		store.load(tempDir);
		store.setEntry(entry("aaaa1111", "bbbb2222", "意図的", "partial", "2026-07-07T00:00:00.000Z"));
		store.save(tempDir);
		assert.ok(fs.existsSync(path.join(tempDir, "audit-ledger")));

		AuditLedgerStore.dispose();
		const reloaded = AuditLedgerStore.getInstance();
		reloaded.load(tempDir);
		assert.strictEqual(reloaded.isAccepted("aaaa1111", "bbbb2222"), true);
		assert.strictEqual(reloaded.getEntry("aaaa1111", "bbbb2222")?.note, "意図的");
	});

	test("hash は大文字小文字を区別せず一致する", () => {
		const store = AuditLedgerStore.getInstance();
		store.load(tempDir);
		store.setEntry(entry("AAAA1111", "BBBB2222"));
		assert.strictEqual(store.isAccepted("aaaa1111", "bbbb2222"), true);
	});

	test("dirty でなければ save でファイルを書かない", () => {
		const store = AuditLedgerStore.getInstance();
		store.load(tempDir);
		store.save(tempDir);
		assert.strictEqual(fs.existsSync(path.join(tempDir, "audit-ledger")), false);
	});

	test("removeEntry で受理を取り消せる", () => {
		const store = AuditLedgerStore.getInstance();
		store.load(tempDir);
		store.setEntry(entry("aaaa1111", "bbbb2222"));
		store.removeEntry("aaaa1111", "bbbb2222");
		assert.strictEqual(store.isAccepted("aaaa1111", "bbbb2222"), false);
	});

	test("retainOnly で activeKeys 外のエントリを GC する", () => {
		const store = AuditLedgerStore.getInstance();
		store.load(tempDir);
		store.setEntry(entry("aaaa1111", "bbbb2222"));
		store.setEntry(entry("cccc3333", "dddd4444"));
		const removed = store.retainOnly(new Set([ledgerKey("aaaa1111", "bbbb2222")]));
		assert.strictEqual(removed, 1);
		assert.strictEqual(store.isAccepted("aaaa1111", "bbbb2222"), true);
		assert.strictEqual(store.isAccepted("cccc3333", "dddd4444"), false);
	});
});
