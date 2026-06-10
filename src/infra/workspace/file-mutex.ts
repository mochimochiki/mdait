import * as path from "node:path";

/**
 * ファイルパス単位の非同期排他制御（キー付きミューテックス）。
 *
 * sync・trans・保存時自動syncは同一ファイルを read-modify-write するため、
 * 並行実行されると後勝ちの上書きでマーカーや翻訳結果が失われる。
 * 同じファイルへの操作を獲得順（FIFO）に直列化し、異なるファイルへの操作は
 * 並行のまま許可することでこれを防ぐ。
 *
 * 複数キーの獲得は同期的に一括登録されるため、部分獲得によるデッドロックは
 * 発生しない。再入は非対応（同一キーをロック保持中に再度獲得すると待機し続ける）。
 */
export class FileMutex {
	private static instance: FileMutex | undefined;
	private readonly tails = new Map<string, Promise<void>>();

	private constructor() {}

	static getInstance(): FileMutex {
		if (!FileMutex.instance) {
			FileMutex.instance = new FileMutex();
		}
		return FileMutex.instance;
	}

	/** シングルトンインスタンスを破棄する（主にテスト用） */
	static dispose(): void {
		FileMutex.instance = undefined;
	}

	/**
	 * 指定したファイルパス群のロックを獲得してタスクを実行する。
	 * いずれかのパスに対する先行タスクがあれば、その完了を待ってから実行する。
	 * タスクが例外を投げてもロックは解放される。
	 *
	 * @param keys 排他対象のファイルパス（絶対パス推奨）
	 * @param task ロック保持中に実行する処理
	 */
	async runExclusive<T>(keys: string[], task: () => Promise<T>): Promise<T> {
		const normalized = [...new Set(keys.map((k) => path.resolve(k)))];
		const prior = Promise.all(normalized.map((k) => this.tails.get(k) ?? Promise.resolve()));
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		for (const k of normalized) {
			this.tails.set(k, gate);
		}
		await prior;
		try {
			return await task();
		} finally {
			release();
			for (const k of normalized) {
				if (this.tails.get(k) === gate) {
					this.tails.delete(k);
				}
			}
		}
	}
}
