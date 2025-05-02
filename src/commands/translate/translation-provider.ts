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

  /**
   * CSVを翻訳する
   * @param csv 翻訳対象のCSVテキスト
   * @param config 設定
   */
  translateCsv(csv: string, config: Configuration): Promise<string>;
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
    config: Configuration
  ): Promise<string> {
    if (!config.translation.markdown.skipCodeBlocks) {
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
    const translatedWithoutCodeBlocks = await this.translateText(
      withoutCodeBlocks
    );

    // プレースホルダーをコードブロックに戻す
    let result = translatedWithoutCodeBlocks;
    for (let i = 0; i < placeholders.length; i++) {
      result = result.replace(placeholders[i], codeBlocks[i]);
    }

    return result;
  }

  /**
   * CSVを翻訳する
   * @param csv 翻訳対象のCSVテキスト
   * @param config 設定
   */
  public async translateCsv(
    csv: string,
    config: Configuration
  ): Promise<string> {
    const delimiter = config.translation.csv.delimiter;

    // CSVを行に分割
    const lines = csv.split("\n");
    const translatedLines: string[] = [];

    // 各行を処理
    for (const line of lines) {
      // 行をセルに分割
      const cells = line.split(delimiter);
      const translatedCells: string[] = [];

      // 各セルを翻訳
      for (const cell of cells) {
        // セルの値を翻訳
        const trimmedCell = cell.trim();
        if (trimmedCell) {
          const translatedCell = await this.translateText(trimmedCell);
          translatedCells.push(translatedCell);
        } else {
          translatedCells.push("");
        }
      }

      // 翻訳後のセルを結合して行に戻す
      translatedLines.push(translatedCells.join(delimiter));
    }

    // 翻訳後の行を結合してCSVに戻す
    return translatedLines.join("\n");
  }
}
