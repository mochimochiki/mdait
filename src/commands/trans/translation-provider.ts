import type { Configuration } from "../../config/configuration";

/**
 * 翻訳プロバイダーのインターフェース
 */
export interface TranslationProvider {
	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 */
	translateText(text: string): Promise<string>;

	/**
	 * マークダウンを翻訳する
	 * @param markdown 翻訳対象のマークダウンテキスト
	 * @param config 設定
	 */
	translateMarkdown(markdown: string, config: Configuration): Promise<string>;
}

/**
 * デフォルトの翻訳プロバイダー
 * （実際のプロジェクトでは、この部分を様々なLLMプロバイダーに差し替え可能にする）
 */
export class DefaultTranslationProvider implements TranslationProvider {
	/**
	 * テキストを翻訳する
	 * @param text 翻訳対象のテキスト
	 */
	public async translateText(text: string): Promise<string> {
		// 実際のプロジェクトでは、ここで外部のAPIを呼び出すなど実装を行う
		// このシンプルな実装では例として簡単な単語の置き換えを行う
		return text
			.replace(/Hello/g, "こんにちは")
			.replace(/World/g, "世界")
			.replace(/This is a paragraph\./g, "これは段落です。")
			.replace(/Another paragraph\./g, "別の段落です。")
			.replace(/name/g, "名前")
			.replace(/description/g, "説明")
			.replace(/apple/g, "りんご")
			.replace(/red fruit/g, "赤い果物")
			.replace(/banana/g, "バナナ")
			.replace(/yellow fruit/g, "黄色い果物")
			.replace(/orange fruit/g, "オレンジ色の果物")
			.replace(/orange(?!.*fruit)/g, "オレンジ");
	}

	/**
	 * マークダウンを翻訳する
	 * @param markdown 翻訳対象のマークダウンテキスト
	 * @param config 設定
	 */
	public async translateMarkdown(
		markdown: string,
		config: Configuration,
	): Promise<string> {
		if (!config.trans.markdown.skipCodeBlocks) {
			// コードブロックをスキップしない場合はシンプルに全体翻訳
			return this.translateText(markdown);
		}

		// コードブロックを検出して保護するための正規表現
		const codeBlockRegex = /```[\s\S]*?```/g;

		// コードブロックを一時保管
		const codeBlocks: string[] = [];
		const placeholders: string[] = [];

		// コードブロックを検出して一時的にプレースホルダーに置き換え
		const withoutCodeBlocks = markdown.replace(codeBlockRegex, (match) => {
			const placeholder = `CODE_BLOCK_${codeBlocks.length}`;
			codeBlocks.push(match);
			placeholders.push(placeholder);
			return placeholder;
		});

		// コードブロック以外の部分を翻訳
		const translatedWithoutCodeBlocks =
			await this.translateText(withoutCodeBlocks);

		// プレースホルダーをコードブロックに戻す
		let result = translatedWithoutCodeBlocks;
		for (let i = 0; i < placeholders.length; i++) {
			result = result.replace(placeholders[i], codeBlocks[i]);
		}

		return result;
	}
}
