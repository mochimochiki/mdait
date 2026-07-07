/**
 * @file audit-ledger-encoder.ts
 * @description
 *   受理台帳（audit ledger）の TSV シリアライズ/パースを担う純関数群。
 *   **VS Code API / fs 非依存**（単体テストの中心）。
 *   台帳は audit で `flagged`（報告のみ）になった確定済みペアを、人間が
 *   「意図的な乖離なので受理」した記録を `(targetHash, fromHash)` キーで永続化する。
 *   内容（訳文=targetHash / 原文=fromHash）が変わらない限り audit は再報告しない。
 * @module core/audit-ledger/audit-ledger-encoder
 */

/** 台帳エントリ1件 */
export interface AuditLedgerEntry {
	/** 受理したターゲット（訳文）ユニットの CRC32 hash（= marker.hash） */
	targetHash: string;
	/** 受理した翻訳元（原文）ユニットの hash（= marker.from） */
	fromHash: string;
	/** 受理時点の AI 判定（partial/mismatch 等・情報用。不明時は "flagged"） */
	verdict: string;
	/** 受理日時（ISO 8601）。空文字も許容 */
	acceptedAt: string;
	/** 人間が記録した受理理由コメント（任意） */
	note: string;
}

/** TSV のカラム数 */
const EXPECTED_COLUMN_COUNT = 5;

/** ヘッダーコメント行 */
export const AUDIT_LEDGER_HEADER = [
	"# mdait audit-ledger — audit で報告された確定済みペアの「意図的な乖離」受理記録",
	"# targetHash\tfromHash\tverdict\tacceptedAt\tnote",
];

/** 複合キー（targetHash, fromHash）を Map キーへ変換する */
export function ledgerKey(targetHash: string, fromHash: string): string {
	return `${targetHash.toLowerCase()} ${fromHash.toLowerCase()}`;
}

/** note を1行 TSV セルへ安全にエンコードする（バックスラッシュ→タブ→改行の順で退避） */
function escapeNote(note: string): string {
	return note.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n/g, "\\n");
}

/** escapeNote の逆変換 */
function unescapeNote(encoded: string): string {
	let result = "";
	for (let i = 0; i < encoded.length; i++) {
		const ch = encoded[i];
		if (ch !== "\\" || i === encoded.length - 1) {
			result += ch;
			continue;
		}
		const next = encoded[i + 1];
		if (next === "t") {
			result += "\t";
		} else if (next === "n") {
			result += "\n";
		} else if (next === "\\") {
			result += "\\";
		} else {
			result += next;
		}
		i++;
	}
	return result;
}

/**
 * TSV 文字列をパースしてエントリの Map（key=ledgerKey）を返す（純関数）。
 * 空行・コメント行・列数不一致の行はスキップする（決定的・破損耐性）。
 * 同一キーの重複行は後勝ちで上書きする。
 */
export function parseAuditLedger(content: string): Map<string, AuditLedgerEntry> {
	const entries = new Map<string, AuditLedgerEntry>();
	if (!content.trim()) {
		return entries;
	}

	for (const line of content.split("\n")) {
		if (line.trim() === "" || line.startsWith("#")) {
			continue;
		}
		const columns = line.split("\t");
		if (columns.length !== EXPECTED_COLUMN_COUNT) {
			continue;
		}
		const [targetHash, fromHash, verdict, acceptedAt, note] = columns;
		if (!targetHash || !fromHash) {
			continue;
		}
		const entry: AuditLedgerEntry = {
			targetHash: targetHash.toLowerCase(),
			fromHash: fromHash.toLowerCase(),
			verdict,
			acceptedAt,
			note: unescapeNote(note),
		};
		entries.set(ledgerKey(entry.targetHash, entry.fromHash), entry);
	}
	return entries;
}

/**
 * エントリ群を決定的順序（targetHash 昇順 → fromHash 昇順）で TSV へシリアライズする（純関数）。
 * git の diff/マージが安定するよう順序を固定する。末尾に改行を付与する。
 */
export function serializeAuditLedger(entries: Iterable<AuditLedgerEntry>): string {
	const sorted = [...entries].sort((a, b) => {
		const c = a.targetHash.localeCompare(b.targetHash);
		return c !== 0 ? c : a.fromHash.localeCompare(b.fromHash);
	});

	const lines: string[] = [...AUDIT_LEDGER_HEADER];
	for (const e of sorted) {
		lines.push(`${e.targetHash}\t${e.fromHash}\t${e.verdict}\t${e.acceptedAt}\t${escapeNote(e.note)}`);
	}
	return `${lines.join("\n")}\n`;
}
