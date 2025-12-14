/**
 * @file command-add.ts
 * @description 用語集に新しい用語を追加するコマンド
 * @module commands/term/command-add
 */
import * as vscode from "vscode";
import { Configuration } from "../../config/configuration";
import { TermEntry } from "./term-entry";
import { TermsRepository } from "./terms-repository";

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

		// 用語集リポジトリを読み込みまたは作成
		let termsRepository: TermsRepository;
		try {
			termsRepository = await TermsRepository.load(termFilePath);
		} catch {
			// 用語集ファイルが存在しない場合は新規作成
			termsRepository = await TermsRepository.create(termFilePath, config.transPairs);
		}

		// 新しい用語エントリを作成
		const newEntry = TermEntry.create(termArgs.context || termArgs.source, {
			[termArgs.sourceLang]: {
				term: termArgs.source,
				variants: [],
			},
			[termArgs.targetLang]: {
				term: termArgs.target,
				variants: [],
			},
		});

		// 用語集にマージ（重複チェック込み）
		await termsRepository.Merge([newEntry], config.transPairs);

		// 保存
		await termsRepository.save();

		vscode.window.showInformationMessage(
			vscode.l10n.t('Term added to glossary: "{0}" → "{1}"', termArgs.source, termArgs.target),
		);
	} catch (error) {
		vscode.window.showErrorMessage(vscode.l10n.t("Failed to add term to glossary: {0}", (error as Error).message));
		console.error("Failed to add term to glossary:", error);
	}
}
