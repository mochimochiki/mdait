/**
 * @file command-add.ts
 * @description 用語集に新しい用語を追加するコマンド
 * @module commands/term/command-add
 */
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";

/**
 * 用語追加コマンドの引数インターフェース
 */
interface AddToGlossaryArgs {
	/** 原語 */
	source: string;
	/** 訳語 */
	target: string;
	/** コンテキスト情報 */
	context?: string;
	/** 原語の言語コード */
	sourceLang: string;
	/** 訳語の言語コード */
	targetLang: string;
}

/**
 * addToGlossary command
 * 用語集ファイルに新しい用語を追加する
 */
export async function addToGlossaryCommand(args?: AddToGlossaryArgs): Promise<void> {
	try {
		const config = Configuration.getInstance();
		const termFilePath = config.getTermsFilePath();

		// 引数が渡されていない場合は入力ダイアログを表示
		let termArgs = args;
		if (!termArgs) {
			const source = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Enter source term"),
				placeHolder: vscode.l10n.t("e.g., Configuration"),
			});

			if (!source) {
				return; // キャンセル
			}

			const target = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Enter target term"),
				placeHolder: vscode.l10n.t("e.g., 設定"),
			});

			if (!target) {
				return; // キャンセル
			}

			const context = await vscode.window.showInputBox({
				prompt: vscode.l10n.t("Enter context (optional)"),
				placeHolder: vscode.l10n.t("e.g., Application settings"),
			});

			termArgs = {
				source,
				target,
				context: context || "",
				sourceLang: "en", // デフォルト
				targetLang: "ja", // デフォルト
			};
		}

		// ファイルが存在するか確認
		let fileExists = true;
		try {
			await vscode.workspace.fs.stat(vscode.Uri.file(termFilePath));
		} catch {
			fileExists = false;
		}

		// ファイルを開く（存在しない場合は作成）
		let document: vscode.TextDocument;
		if (fileExists) {
			document = await vscode.workspace.openTextDocument(termFilePath);
		} else {
			// 新規作成
			const uri = vscode.Uri.file(termFilePath);
			await vscode.workspace.fs.writeFile(uri, Buffer.from(""));
			document = await vscode.workspace.openTextDocument(uri);
		}

		const editor = await vscode.window.showTextDocument(document);

		// ファイル形式を判定（拡張子から）
		const isYaml = termFilePath.endsWith(".yaml") || termFilePath.endsWith(".yml");
		const isCsv = termFilePath.endsWith(".csv");

		// 用語を追加する文字列を生成
		let newEntry: string;
		if (isYaml) {
			newEntry = generateYamlEntry(termArgs);
		} else if (isCsv) {
			newEntry = generateCsvEntry(termArgs);
		} else {
			vscode.window.showErrorMessage(
				vscode.l10n.t("Unsupported glossary file format. Use .yaml or .csv"),
			);
			return;
		}

		// ファイルの最後に追加
		const lastLine = document.lineCount - 1;
		const lastLineText = document.lineAt(lastLine).text;
		const needsNewline = lastLineText.trim() !== "";

		await editor.edit((editBuilder) => {
			const position = new vscode.Position(document.lineCount, 0);
			const textToInsert = needsNewline ? `\n${newEntry}` : newEntry;
			editBuilder.insert(position, textToInsert);
		});

		// 保存
		await document.save();

		vscode.window.showInformationMessage(
			vscode.l10n.t('Term added to glossary: "{0}" → "{1}"', termArgs.source, termArgs.target),
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("Failed to add term to glossary: {0}", (error as Error).message),
		);
		console.error("Failed to add term to glossary:", error);
	}
}

/**
 * YAML形式の用語エントリを生成
 */
function generateYamlEntry(args: AddToGlossaryArgs): string {
	const lines: string[] = [];
	lines.push(`- context: "${args.context || args.source}"`);
	lines.push("  languages:");
	lines.push(`    ${args.sourceLang}:`);
	lines.push(`      term: "${args.source}"`);
	lines.push("      variants: []");
	lines.push(`    ${args.targetLang}:`);
	lines.push(`      term: "${args.target}"`);
	lines.push("      variants: []");
	return `${lines.join("\n")}\n`;
}

/**
 * CSV形式の用語エントリを生成
 */
function generateCsvEntry(args: AddToGlossaryArgs): string {
	// CSV形式: context,en.term,en.variants,ja.term,ja.variants
	const context = args.context || args.source;
	const enTerm = args.sourceLang === "en" ? args.source : "";
	const jaTerm = args.targetLang === "ja" ? args.target : "";
	return `"${context}","${enTerm}","","${jaTerm}",""\n`;
}
