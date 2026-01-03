/**
 * @file unit-pair-collector.ts
 * @description ソース・ターゲットのユニットペアを収集するコレクター
 */

import * as vscode from "vscode";
import { Configuration, type TransPair } from "../../config/configuration";
import type { MdaitUnit } from "../../core/markdown/mdait-unit";
import { markdownParser } from "../../core/markdown/parser";
import { FileExplorer } from "../../utils/file-explorer";
import { UnitPair } from "./unit-pair";

// UnitPairをre-export（外部からUnitPairCollectorと一緒にインポートできるように）
export { UnitPair } from "./unit-pair";

/**
 * ユニットペア収集の結果
 */
export interface UnitPairCollectionResult {
	/** 収集されたユニットペア */
	readonly pairs: readonly UnitPair[];
	/** 処理されたソースファイル数 */
	readonly sourceFileCount: number;
	/** 対訳ありのペア数 */
	readonly pairedCount: number;
	/** 対訳なしのペア数 */
	readonly unpairedCount: number;
}

/**
 * ソースユニットから対応するターゲットユニットを検索し、ペアを収集する
 */
export class UnitPairCollector {
	private readonly fileExplorer: FileExplorer;
	private readonly config: Configuration;

	constructor() {
		this.fileExplorer = new FileExplorer();
		this.config = Configuration.getInstance();
	}

	/**
	 * ソースファイル群からユニットペアを収集
	 *
	 * @param sourceFilePaths ソースファイルパスの配列
	 * @param transPair 翻訳ペア設定
	 * @param cancellationToken キャンセルトークン
	 * @returns 収集結果
	 */
	async collectFromFiles(
		sourceFilePaths: readonly string[],
		transPair: TransPair,
		cancellationToken?: vscode.CancellationToken,
	): Promise<UnitPairCollectionResult> {
		const allPairs: UnitPair[] = [];
		const processedHashes = new Set<string>();
		let pairedCount = 0;
		let unpairedCount = 0;

		for (const sourceFilePath of sourceFilePaths) {
			if (cancellationToken?.isCancellationRequested) {
				break;
			}

			try {
				const filePairs = await this.collectFromFile(sourceFilePath, transPair, processedHashes, cancellationToken);

				for (const pair of filePairs) {
					allPairs.push(pair);
					if (UnitPair.hasTarget(pair)) {
						pairedCount++;
					} else {
						unpairedCount++;
					}
				}
			} catch (error) {
				console.error(`Failed to collect pairs from file: ${sourceFilePath}`, error);
			}
		}

		return {
			pairs: allPairs,
			sourceFileCount: sourceFilePaths.length,
			pairedCount,
			unpairedCount,
		};
	}

	/**
	 * 単一ソースファイルからユニットペアを収集
	 */
	private async collectFromFile(
		sourceFilePath: string,
		transPair: TransPair,
		processedHashes: Set<string>,
		cancellationToken?: vscode.CancellationToken,
	): Promise<UnitPair[]> {
		const pairs: UnitPair[] = [];

		// ソースファイルをパース
		const sourceDoc = await vscode.workspace.openTextDocument(sourceFilePath);
		const sourceMarkdown = markdownParser.parse(sourceDoc.getText(), this.config);

		// ターゲットファイルを取得（存在しない場合はundefined）
		const targetFilePath = this.fileExplorer.getTargetPath(sourceFilePath, transPair);
		let targetUnits: readonly MdaitUnit[] = [];

		if (targetFilePath) {
			try {
				const targetDoc = await vscode.workspace.openTextDocument(targetFilePath);
				const targetMarkdown = markdownParser.parse(targetDoc.getText(), this.config);
				targetUnits = targetMarkdown.units;
			} catch {
				// ターゲットファイルが存在しない場合は空配列のまま
			}
		}

		// ソースユニットごとにペアを作成
		for (const sourceUnit of sourceMarkdown.units) {
			if (cancellationToken?.isCancellationRequested) {
				break;
			}

			const sourceHash = sourceUnit.marker?.hash;
			if (!sourceHash) {
				continue;
			}

			// 重複チェック
			if (processedHashes.has(sourceHash)) {
				continue;
			}
			processedHashes.add(sourceHash);

			// 対応するターゲットユニットを検索（from:hashで紐付け）
			const targetUnit = this.findTargetUnit(targetUnits, sourceHash);

			pairs.push(UnitPair.create(sourceUnit, targetUnit));
		}

		return pairs;
	}

	/**
	 * ソースのハッシュに対応するターゲットユニットを検索
	 * ターゲットユニットのfrom:hashがソースのhashと一致するものを返す
	 */
	private findTargetUnit(targetUnits: readonly MdaitUnit[], sourceHash: string): MdaitUnit | undefined {
		return targetUnits.find((unit) => unit.marker?.from === sourceHash);
	}

	/**
	 * MdaitUnit配列から直接ユニットペアを収集（ターゲット情報なし）
	 *
	 * @param units ソースユニット配列
	 * @returns ターゲットなしのペア配列
	 */
	collectFromUnits(units: readonly MdaitUnit[]): UnitPair[] {
		return units.map((unit) => UnitPair.create(unit, undefined));
	}
}
