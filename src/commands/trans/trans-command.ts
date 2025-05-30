import * as fs from "node:fs"; // @important Node.jsのbuildinモジュールのimportでは`node:`を使用
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { calculateHash } from "../../core/hash/hash-calculator";
import type { Markdown } from "../../core/markdown/mdait-markdown";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { TranslationContext } from "./translation-context";
import type { Translator } from "./translator";
import { TranslatorBuilder } from "./translator-builder";

export async function transCommand(uri?: vscode.Uri) {
	try {
		// ファイルパスの取得
		const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
		if (!filePath) {
			vscode.window.showErrorMessage("翻訳するファイルが選択されていません。");
			return;
		}

		// 言語設定の入力
		const sourceLang = await vscode.window.showInputBox({
			prompt: "翻訳元の言語コードを入力してください (例: en)",
			value: "auto",
		});
		if (!sourceLang) return;

		const targetLang = await vscode.window.showInputBox({
			prompt: "翻訳先の言語コードを入力してください (例: ja)",
			value: "ja",
		});
		if (!targetLang) return;

		// 設定の読み込み
		const config = new Configuration();
		await config.load();		// AIService と Translator の初期化
		const translator = await new TranslatorBuilder().build();

		vscode.window.showInformationMessage(
			`Translating ${filePath} from ${sourceLang} to ${targetLang}...`,
		); // Markdown ファイルの読み込みとパース
		const markdownContent = await fs.promises.readFile(filePath, "utf-8");
		const markdown = markdownParser.parse(markdownContent, config);

		// need:translate フラグを持つユニットを抽出
		const unitsToTranslate = markdown.units.filter((unit) => unit.needsTranslation());

		if (unitsToTranslate.length === 0) {
			vscode.window.showInformationMessage("翻訳が必要なユニットが見つかりませんでした。");
			return;
		}

		vscode.window.showInformationMessage(
			`${unitsToTranslate.length}個のユニットを翻訳します: ${filePath}`,
		);
		// 各ユニットを翻訳
		for (const unit of unitsToTranslate) {
			await translateUnit(unit, translator, sourceLang, targetLang, markdown);
		}

		// 更新されたMarkdownを保存
		const updatedContent = markdownParser.stringify(markdown);
		await fs.promises.writeFile(filePath, updatedContent, "utf-8");

		vscode.window.showInformationMessage(
			`翻訳完了: ${unitsToTranslate.length}個のユニットを翻訳しました`,
		);
	} catch (error) {
		vscode.window.showErrorMessage(`Error during translation: ${error}`);
	}
}

/**
 * 単一ユニットの翻訳処理
 * @param unit 翻訳対象のユニット
 * @param translator 翻訳サービス
 * @param sourceLang 翻訳元言語
 * @param targetLang 翻訳先言語
 * @param markdown Markdownドキュメント（翻訳元ユニット特定用）
 */
async function translateUnit(
	unit: MdaitUnit,
	translator: Translator,
	sourceLang: string,
	targetLang: string,
	markdown: Markdown,
) {
	try {
		// 翻訳コンテキストの作成
		const context = new TranslationContext();
		// TODO: context に surroundingText や glossary を設定するロジックを実装

		let sourceContent = unit.content;

		// from属性がある場合は、翻訳元ユニットのコンテンツを取得
		if (unit.marker?.from) {
			const sourceUnit = findUnitByHash(markdown.units, unit.marker.from);
			if (sourceUnit) {
				sourceContent = sourceUnit.content;
			}
		}
		// 翻訳実行
		const translatedContent = await translator.translate(
			sourceContent,
			sourceLang,
			targetLang,
			context,
		);
		// ユニットのコンテンツを更新
		unit.content = translatedContent;

		// ハッシュを再計算してmarkerを更新
		if (unit.marker) {
			const newHash = calculateHash(unit.content);
			unit.marker.hash = newHash;
		}

		// needフラグを除去
		unit.markAsTranslated();
	} catch (error) {
		vscode.window.showErrorMessage(`ユニット翻訳エラー: ${error}`);
		throw error;
	}
}

/**
 * ハッシュでユニットを検索
 * @param units ユニット配列
 * @param hash 検索対象のハッシュ
 * @returns 見つかったユニット（なければnull）
 */
function findUnitByHash(units: MdaitUnit[], hash: string): MdaitUnit | null {
	return units.find((unit) => unit.marker?.hash === hash) || null;
}
