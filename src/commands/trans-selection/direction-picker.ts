/**
 * @file direction-picker.ts
 * @description 翻訳方向の選択UI
 * ファイルパスからtransPair候補を抽出し、複数ある場合はQuickPickで選択
 */

import * as vscode from "vscode";
import type { Configuration, TransPair } from "../../config/configuration";

/**
 * 現在のファイルパスから翻訳ペア候補を取得
 * ファイルがsourceDir/targetDirのいずれかに含まれる場合、そのtransPairを候補とする
 * 翻訳方向は常にsource→target
 *
 * @param filePath ファイルパス
 * @param config 設定インスタンス
 * @returns 翻訳ペア候補の配列
 */
function getCandidateDirections(filePath: string, config: Configuration): TransPair[] {
	const candidates: TransPair[] = [];
	const normalizedFilePath = filePath.replace(/\\/g, "/");

	for (const pair of config.transPairs) {
		const normalizedSourceDir = pair.sourceDir.replace(/\\/g, "/");
		const normalizedTargetDir = pair.targetDir.replace(/\\/g, "/");

		// ファイルがsourceDirまたはtargetDirに含まれる場合、候補として追加
		// 翻訳方向は常にsource→target
		if (normalizedFilePath.includes(normalizedSourceDir) || normalizedFilePath.includes(normalizedTargetDir)) {
			candidates.push(pair);
		}
	}

	return candidates;
}

/**
 * 翻訳方向を選択
 * 候補が0件の場合はエラー通知、1件の場合は自動選択、複数の場合はQuickPickで選択
 *
 * @param filePath ファイルパス
 * @param config 設定インスタンス
 * @returns 選択された翻訳ペア（キャンセル時またはエラー時はnull）
 */
export async function pickTranslationDirection(filePath: string, config: Configuration): Promise<TransPair | null> {
	const candidates = getCandidateDirections(filePath, config);

	if (candidates.length === 0) {
		vscode.window.showErrorMessage(
			vscode.l10n.t("This file is not in any configured translation directory. Check mdait.json settings."),
		);
		return null;
	}

	if (candidates.length === 1) {
		// 候補が1件の場合は自動選択
		return candidates[0];
	}

	// 複数候補の場合はQuickPickで選択
	const items = candidates.map((pair) => ({
		label: `$(globe) ${pair.sourceLang} → ${pair.targetLang}`,
		description: vscode.l10n.t("Translate from {0} to {1}", pair.sourceLang, pair.targetLang),
		detail: `${pair.sourceDir} → ${pair.targetDir}`,
		pair,
	}));

	const selected = await vscode.window.showQuickPick(items, {
		placeHolder: vscode.l10n.t("Select translation direction"),
	});

	return selected?.pair ?? null;
}
