/**
 * @file previous-translation-finder.ts
 * @description
 *   原文改訂時に前回の訳文を検索・取得するユーティリティ。
 *   ターゲットユニットの`from`フィールド（旧ソースハッシュ）を使用して、
 *   現在のターゲットファイル内から対応する既存訳文を特定する。
 * @module commands/trans/previous-translation-finder
 */

import * as vscode from "vscode";
import type { Configuration } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";

/**
 * 前回の訳文を検索・取得するクラス
 */
export class PreviousTranslationFinder {
	/**
	 * 前回の訳文を取得する
	 * 
	 * @param unit 翻訳対象のターゲットユニット（need:translate付き）
	 * @param targetFilePath ターゲットファイルのパス
	 * @param config 設定
	 * @returns 前回の訳文（見つからない場合はundefined）
	 */
	public async getPreviousTranslation(
		unit: MdaitUnit,
		targetFilePath: string,
		config: Configuration,
	): Promise<string | undefined> {
		// fromフィールドがない場合は前回訳文なし（新規ユニット）
		const oldSourceHash = unit.marker?.from;
		if (!oldSourceHash) {
			return undefined;
		}

		try {
			// ターゲットファイルを読み込み
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFilePath));
			const content = document.getText();
			const markdown = markdownParser.parse(content, config);

			// 旧ソースハッシュと同じfromを持つユニットを検索
			// これが前回の訳文に対応するユニット
			const previousUnit = markdown.units.find((u) => {
				// unit自身は除外（need:translateが付いているため、まだ翻訳されていない）
				if (u.marker?.hash === unit.marker?.hash) {
					return false;
				}
				// fromが旧ソースハッシュと一致するユニットを検索
				return u.marker?.from === oldSourceHash;
			});

			if (previousUnit) {
				return previousUnit.content;
			}

			return undefined;
		} catch (error) {
			console.warn("Failed to get previous translation:", error);
			return undefined;
		}
	}
}
