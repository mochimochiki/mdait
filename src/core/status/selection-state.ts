import * as vscode from "vscode";
import { Configuration, type TransPair } from "../../infra/config/configuration";

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
	/**
	 * 前回までに設定へ現れていたターゲット。
	 * 「本人が外した」と「まだ一度も見ていない（新しく書き足された）」を分けるためだけに持つ。
	 */
	private knownKeys: Set<string> = new Set<string>();

	private constructor() {}

	/**
	 * 初期化（前回選択の復元→無効なら先頭ターゲット採用）
	 */
	public async initialize(context: vscode.ExtensionContext): Promise<void> {
		this.context = context;
		const config = Configuration.getInstance();
		const keysInConfig = this.collectTargetKeys(config.transPairs);

		this.knownKeys = new Set(this.readKnown());
		const restored = this.readPersisted();
		const validRestored = restored.filter((k) => keysInConfig.includes(k));

		if (validRestored.length > 0) {
			this.activeKeys = new Set(validRestored);
		} else {
			// 初回は**設定したターゲットを全部**選ぶ。
			// 先頭1つだけにしていたので、2言語目を書いた人は sync しても
			// その言語のフォルダが作られず、通知にも「素通りした」と出なかった。
			// 設定に書いたことは本人の宣言なので、狭めるのは明示の操作だけにする
			this.activeKeys = new Set(keysInConfig);
		}

		// 前回いなかったターゲットは、本人が外したのではなく**新しく書き足されたもの**。
		// 足す側に倒さないと、あとから言語を増やした人は初回と同じ無言の取りこぼしを踏む。
		//
		// ただし「覚えが無い」だけの回（この仕組みが入る前から使っている人の初回）は、
		// 本人が絞り込んだ選択を勝手に広げてしまうので、いまの設定を丸ごと既知として控えるに留める
		const firstRunOfMemory = this.readKnown().length === 0 && validRestored.length > 0;
		if (!firstRunOfMemory) {
			for (const key of keysInConfig) {
				if (!this.knownKeys.has(key)) {
					this.activeKeys.add(key);
				}
			}
		}
		this.rememberKnown(keysInConfig);
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

	/**
	 * transPairs 変化などに追従して、選択を補正する。
	 *
	 * 設定から消えたキーは外し、**新しく書き足されたキーは選ぶ**。
	 * 足さないと、あとから言語を増やした人は sync してもそのフォルダが作られず、
	 * 通知にも「素通りした」と出ない（拡張を開き直すまで直らない）。
	 * 「前回いたかどうか」を覚えているので、本人が外した言語を勝手に戻すことはない。
	 */
	public reconcileWith(pairs: TransPair[]): void {
		const keysInConfig = this.collectTargetKeys(pairs);
		const kept = [...this.activeKeys].filter((k) => keysInConfig.includes(k));
		const added = keysInConfig.filter((k) => !this.knownKeys.has(k));
		const next = new Set([...kept, ...added]);
		if (next.size === 0 && keysInConfig.length > 0) {
			// 全部外れると何も動かなくなる。空にはしない
			this.activeKeys = new Set(keysInConfig);
		} else {
			this.activeKeys = next;
		}
		this.rememberKnown(keysInConfig);
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

	/** 前回までに見たターゲットを読む */
	private readKnown(): string[] {
		const arr = this.context?.workspaceState.get<string[]>("mdait.knownTargets");
		return Array.isArray(arr) ? arr : [];
	}

	/** 見たことのあるターゲットを覚え直す */
	private rememberKnown(keysInConfig: readonly string[]): void {
		this.knownKeys = new Set(keysInConfig);
		this.context?.workspaceState.update("mdait.knownTargets", [...this.knownKeys]);
	}

	private persist(): void {
		this.context?.workspaceState.update("mdait.activeTargets", Array.from(this.activeKeys));
	}
}
