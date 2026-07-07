/**
 * @file audit-ledger-store.ts
 * @description
 *   受理台帳（audit ledger）の永続化ストア。
 *   `.mdait/audit-ledger` の TSV を読み書きし、`(targetHash, fromHash)` キーで
 *   「意図的な乖離の受理」を記録する。埋め込み/外部いずれのマーカーでも効く独立ストア
 *   （unit-state は external 専用のため使わない）。シングルトン（UnitStateStore に倣う）。
 * @module core/audit-ledger/audit-ledger-store
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync } from "../../infra/workspace/atomic-write";
import {
	type AuditLedgerEntry,
	ledgerKey,
	parseAuditLedger,
	serializeAuditLedger,
} from "./audit-ledger-encoder";

/** 台帳ファイル名 */
const AUDIT_LEDGER_FILENAME = "audit-ledger";

/**
 * 受理台帳ストア。
 * `.mdait/audit-ledger` を読み書きする。値は決定的順序でシリアライズされ git フレンドリー。
 */
export class AuditLedgerStore {
	private static instance: AuditLedgerStore | undefined;
	private entries: Map<string, AuditLedgerEntry> = new Map();
	private dirty = false;
	private loaded = false;
	private mdaitDir: string | undefined;

	private constructor() {}

	static getInstance(): AuditLedgerStore {
		if (!AuditLedgerStore.instance) {
			AuditLedgerStore.instance = new AuditLedgerStore();
		}
		return AuditLedgerStore.instance;
	}

	static dispose(): void {
		AuditLedgerStore.instance = undefined;
	}

	/** `.mdait/audit-ledger` を読み込む */
	load(mdaitDir: string): void {
		this.mdaitDir = mdaitDir;
		this.entries.clear();
		this.dirty = false;

		const filePath = path.join(mdaitDir, AUDIT_LEDGER_FILENAME);
		if (!fs.existsSync(filePath)) {
			this.loaded = true;
			return;
		}
		this.entries = parseAuditLedger(fs.readFileSync(filePath, "utf-8"));
		this.loaded = true;
	}

	/** 未ロードなら mdaitDir から読み込む（単独トリガー用） */
	ensureLoaded(mdaitDir: string): void {
		this.mdaitDir = mdaitDir;
		if (!this.loaded) {
			this.load(mdaitDir);
		}
	}

	/** 変更があればファイルへ書き戻す */
	save(mdaitDir: string): void {
		if (!this.dirty) {
			return;
		}
		const filePath = path.join(mdaitDir, AUDIT_LEDGER_FILENAME);
		atomicWriteFileSync(filePath, serializeAuditLedger(this.entries.values()), "utf-8");
		this.dirty = false;
	}

	private autoLoad(): void {
		if (!this.loaded && this.mdaitDir) {
			this.load(this.mdaitDir);
		}
	}

	/** 指定ペアが受理済みかを判定する（audit で AI 呼び出しをスキップするゲート） */
	isAccepted(targetHash: string, fromHash: string): boolean {
		this.autoLoad();
		return this.entries.has(ledgerKey(targetHash, fromHash));
	}

	/** 受理エントリを取得する（hover 表示・存在確認用） */
	getEntry(targetHash: string, fromHash: string): AuditLedgerEntry | undefined {
		this.autoLoad();
		return this.entries.get(ledgerKey(targetHash, fromHash));
	}

	/** 受理エントリを記録する（既存キーは上書き） */
	setEntry(entry: AuditLedgerEntry): void {
		this.autoLoad();
		const normalized: AuditLedgerEntry = {
			...entry,
			targetHash: entry.targetHash.toLowerCase(),
			fromHash: entry.fromHash.toLowerCase(),
		};
		this.entries.set(ledgerKey(normalized.targetHash, normalized.fromHash), normalized);
		this.dirty = true;
	}

	/** 受理エントリを削除する（受理の取り消し） */
	removeEntry(targetHash: string, fromHash: string): void {
		this.autoLoad();
		if (this.entries.delete(ledgerKey(targetHash, fromHash))) {
			this.dirty = true;
		}
	}

	/** 全エントリを返す */
	getAllEntries(): AuditLedgerEntry[] {
		this.autoLoad();
		return [...this.entries.values()];
	}

	/**
	 * activeKeys（`ledgerKey` 形式）に含まれないエントリを削除する（GC）。
	 * ワークスペースに現存する `(targetHash, fromHash)` ペアの集合を渡して残留受理を掃除する。
	 * @returns 削除件数
	 */
	retainOnly(activeKeys: Set<string>): number {
		this.autoLoad();
		let removed = 0;
		for (const key of [...this.entries.keys()]) {
			if (!activeKeys.has(key)) {
				this.entries.delete(key);
				removed++;
			}
		}
		if (removed > 0) {
			this.dirty = true;
		}
		return removed;
	}
}
