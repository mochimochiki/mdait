import * as vscode from "vscode";
import { Configuration, type TransPair } from "../../config/configuration";

/**
 * 対象言語（ターゲット）選択状態の一元管理
 * - workspaceState に永続化
 * - Configuration.transPairs に追従して整合性を補正
 * - 変更イベントを発火
 */
export class SelectionState {
	private static instance: SelectionState | undefined;

	public static getInstance(): SelectionState {
		if (!SelectionState.instance) {
			SelectionState.instance = new SelectionState();
		}
		return SelectionState.instance;
	}

	private readonly onChangedEmitter = new vscode.EventEmitter<void>();
	public readonly onChanged = this.onChangedEmitter.event;

	private context: vscode.ExtensionContext | undefined;
	private activeKeys: Set<string> = new Set<string>();

	private constructor() {}

	/**
	 * 初期化（前回選択の復元→無効なら先頭ターゲット採用）
	 */
	public async initialize(context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		const config = Configuration.getInstance();
		const keysInConfig = this.collectTargetKeys(config.transPairs);

		const restored = this.readPersisted();
		const validRestored = restored.filter((k) => keysInConfig.includes(k));

		if (validRestored.length > 0) {
			this.activeKeys = new Set(validRestored);
		} else {
			// 初回: 先頭のターゲットを1つ選択
			const first = keysInConfig[0];
			if (first) this.activeKeys = new Set([first]);
			else this.activeKeys.clear();
		}

		this.persist();
	}

	/** 選択キーを取得 */
	public getActiveKeys(): ReadonlySet<string> {
		return this.activeKeys;
	}

	/** 現在の transPairs から選択候補リストを作成（定義順・重複除去） */
	public getSelectableTargets(): { key: string; label: string; description?: string }[] {
		const config = Configuration.getInstance();
		const list: { key: string; label: string; description?: string }[] = [];
		const seen = new Set<string>();
		for (const p of config.transPairs) {
			const key = this.getKey(p);
			if (seen.has(key)) continue;
			seen.add(key);
			const label = p.targetLang ?? p.targetDir;
			const description =
				p.sourceLang && p.targetLang ? `${p.sourceLang} -> ${p.targetLang}` : `${p.sourceDir} -> ${p.targetDir}`;
			list.push({ key, label, description });
		}
		return list;
	}

	/** transPairs のうち選択中のものだけを返す */
	public filterTransPairs(pairs: TransPair[]): TransPair[] {
		return pairs.filter((p) => this.activeKeys.has(this.getKey(p)));
	}

	/** transPairs 変化などに追従して、選択を補正（空になりそうなら先頭を選択） */
	public reconcileWith(pairs: TransPair[]): void {
		const keysInConfig = this.collectTargetKeys(pairs);
		const newActive = [...this.activeKeys].filter((k) => keysInConfig.includes(k));
		if (newActive.length === 0 && keysInConfig.length > 0) {
			this.activeKeys = new Set([keysInConfig[0]]);
		} else {
			this.activeKeys = new Set(newActive);
		}
		this.persist();
		this.onChangedEmitter.fire();
	}

	/** 選択を更新（空は不可のため無視する） */
	public updateSelection(keys: string[]): void {
		if (!keys || keys.length === 0) return; // 空禁止
		this.activeKeys = new Set(keys);
		this.persist();
		this.onChangedEmitter.fire();
	}

	// ========== 内部ユーティリティ ==========

	private getKey(p: TransPair): string {
		return p.targetLang ?? p.targetDir;
	}

	private collectTargetKeys(pairs: TransPair[]): string[] {
		const seen = new Set<string>();
		const result: string[] = [];
		for (const p of pairs) {
			const key = this.getKey(p);
			if (seen.has(key)) continue;
			seen.add(key);
			result.push(key);
		}
		return result;
	}

	private readPersisted(): string[] {
		const arr = this.context?.workspaceState.get<string[]>("mdait.activeTargets");
		return Array.isArray(arr) ? arr : [];
	}

	private persist(): void {
		this.context?.workspaceState.update("mdait.activeTargets", Array.from(this.activeKeys));
	}
}
