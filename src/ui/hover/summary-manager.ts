/**
 * @file summary-manager.ts
 * @description
 *   翻訳サマリ情報を一時的に保持・管理するマネージャー。
 *   翻訳コマンド実行時に生成されたサマリデータをメモリ上で管理し、Hover表示時に提供する。
 *   永続化は不要で、VS Code再起動時やファイルクローズ時にクリアされる。
 * @module ui/hover/summary-manager
 */

/**
 * 適用された用語情報
 */
export interface AppliedTerm {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** コンテキスト情報 */
	context?: string;
}

/**
 * 用語追加候補情報
 */
export interface TermCandidate {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** コンテキスト情報 */
	context: string;
	/** 原語の言語コード */
	sourceLang: string;
	/** 訳語の言語コード */
	targetLang: string;
}

/**
 * TM参照ヒット情報
 */
export interface TmReferenceInfo {
	/** ソース文 */
	source: string;
	/** ターゲット文 */
	target: string;
	/** 出典情報（オプション） */
	firstUsedIn?: string;
}

/**
 * 翻訳サマリ情報のインターフェース
 */
export interface TranslationSummary {
	/** ユニットのハッシュ値（検索キー） */
	unitHash: string;

	/** 翻訳統計情報 */
	stats: {
		/** 翻訳処理時間（秒） */
		duration: number;
		/** 使用トークン数（オプション） */
		tokens?: number;
	};

	/** 翻訳時に適用された用語のリスト */
	appliedTerms?: AppliedTerm[];

	/** 用語集への追加候補 */
	termCandidates?: TermCandidate[];

	/** TM参照ヒット情報 */
	tmReferences?: TmReferenceInfo[];

	/** 注意事項や警告メッセージ */
	warnings?: string[];

	/** レビュー推奨理由（need:reviewが設定された理由） */
	reviewReasons?: string[];

	/**
	 * 直近の AI レビュー/監査で取ったアクション（"flagged" / "accepted" 等）。
	 * CodeLens が flagged 確定済みペアに「意図的として受理」ボタンを出すために参照する。
	 * セッション内メモリのみで永続化しない。
	 */
	reviewAction?: string;

	/** 直近の AI レビュー/監査の verdict（受理時に台帳へ記録する情報） */
	reviewVerdict?: string;
}

/**
 * 翻訳サマリを管理するマネージャークラス
 * シングルトンパターンで実装
 */
export class SummaryManager {
	private static instance: SummaryManager;

	/** サマリデータの保持（unitHashをキーとしたMap） */
	private summaries: Map<string, TranslationSummary>;

	/**
	 * Constructor (private)
	 */
	private constructor() {
		this.summaries = new Map();
	}

	/**
	 * シングルトンインスタンスを取得
	 */
	public static getInstance(): SummaryManager {
		if (!SummaryManager.instance) {
			SummaryManager.instance = new SummaryManager();
		}
		return SummaryManager.instance;
	}

	/**
	 * 翻訳サマリを保存
	 * @param unitHash ユニットのハッシュ値
	 * @param summary 翻訳サマリ情報
	 */
	public saveSummary(unitHash: string, summary: TranslationSummary): void {
		this.summaries.set(unitHash, summary);
	}

	/**
	 * 翻訳サマリを取得
	 * @param unitHash ユニットのハッシュ値
	 * @returns 翻訳サマリ情報（存在しない場合はundefined）
	 */
	public getSummary(unitHash: string): TranslationSummary | undefined {
		return this.summaries.get(unitHash);
	}

	/**
	 * 特定のユニットのサマリをクリア
	 * @param unitHash ユニットのハッシュ値
	 */
	public clearSummary(unitHash: string): void {
		this.summaries.delete(unitHash);
	}

	/**
	 * すべてのサマリをクリア
	 */
	public clearAll(): void {
		this.summaries.clear();
	}

	/**
	 * 保持しているサマリの数を取得
	 */
	public size(): number {
		return this.summaries.size;
	}
}
