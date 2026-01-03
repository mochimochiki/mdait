/**
 * @file translation-checker.ts
 * @description
 *   翻訳結果の品質をチェックし、確認推奨箇所を検出するモジュール。
 *   数値の不一致、リスト項目数の差異、コードブロック数の不一致などを検出。
 * @module commands/trans/translation-checker
 */

/**
 * 確認推奨理由
 */
export interface ReviewReason {
	/** 理由のカテゴリ */
	category: "number_mismatch" | "list_count_mismatch" | "code_block_mismatch" | "structure_mismatch";
	/** 詳細メッセージ */
	message: string;
}

/**
 * 翻訳チェック結果
 */
export interface TranslationCheckResult {
	/** 確認推奨かどうか */
	needsReview: boolean;
	/** 確認推奨理由のリスト */
	reasons: ReviewReason[];
}

/**
 * 翻訳品質チェッカー
 */
export class TranslationChecker {
	/**
	 * 翻訳結果の品質をチェック
	 *
	 * @param sourceText 原文
	 * @param translatedText 訳文
	 * @returns チェック結果
	 */
	public checkTranslationQuality(sourceText: string, translatedText: string): TranslationCheckResult {
		const reasons: ReviewReason[] = [];

		// 数値の抽出と比較
		const sourceNumbers = this.extractNumbers(sourceText);
		const translatedNumbers = this.extractNumbers(translatedText);

		if (!this.arraysEqual(sourceNumbers, translatedNumbers)) {
			reasons.push({
				category: "number_mismatch",
				message: `数値の不一致: 原文[${sourceNumbers.join(", ")}] vs 訳文[${translatedNumbers.join(", ")}]`,
			});
		}

		// リスト項目数の比較
		const sourceListItems = this.countListItems(sourceText);
		const translatedListItems = this.countListItems(translatedText);

		if (sourceListItems !== translatedListItems) {
			reasons.push({
				category: "list_count_mismatch",
				message: `リスト項目数の不一致: 原文${sourceListItems}項目 vs 訳文${translatedListItems}項目`,
			});
		}

		// コードブロック数の比較
		const sourceCodeBlocks = this.countCodeBlocks(sourceText);
		const translatedCodeBlocks = this.countCodeBlocks(translatedText);

		if (sourceCodeBlocks !== translatedCodeBlocks) {
			reasons.push({
				category: "code_block_mismatch",
				message: `コードブロック数の不一致: 原文${sourceCodeBlocks}個 vs 訳文${translatedCodeBlocks}個`,
			});
		}

		return {
			needsReview: reasons.length > 0,
			reasons,
		};
	}

	/**
	 * テキストから数値を抽出
	 * @param text テキスト
	 * @returns 数値の配列
	 */
	private extractNumbers(text: string): number[] {
		// 数値を抽出（整数および小数）
		const numberRegex = /\b\d+(?:\.\d+)?\b/g;
		const matches = text.match(numberRegex);
		return matches ? matches.map((n) => Number.parseFloat(n)) : [];
	}

	/**
	 * 配列が等しいかチェック
	 * @param arr1 配列1
	 * @param arr2 配列2
	 * @returns 等しい場合true
	 */
	private arraysEqual(arr1: number[], arr2: number[]): boolean {
		if (arr1.length !== arr2.length) {
			return false;
		}
		for (let i = 0; i < arr1.length; i++) {
			if (arr1[i] !== arr2[i]) {
				return false;
			}
		}
		return true;
	}

	/**
	 * リスト項目数をカウント
	 * @param text テキスト
	 * @returns リスト項目数
	 */
	private countListItems(text: string): number {
		// 箇条書き（-、*、+）と番号付きリスト（1.、2.など）をカウント
		const listRegex = /^[\s]*[-*+][\s]+|^[\s]*\d+\.[\s]+/gm;
		const matches = text.match(listRegex);
		return matches ? matches.length : 0;
	}

	/**
	 * コードブロック数をカウント
	 * @param text テキスト
	 * @returns コードブロック数
	 */
	private countCodeBlocks(text: string): number {
		// ```で囲まれたコードブロックをカウント
		const codeBlockRegex = /```[\s\S]*?```/g;
		const matches = text.match(codeBlockRegex);
		return matches ? matches.length : 0;
	}
}
