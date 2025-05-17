import { calculateHash } from "../../core/hash/hash-calculator";
import { MdaitHeader } from "../../core/markdown/mdait-header";
import { MdaitSection } from "../../core/markdown/mdait-section";

/**
 * セクション対応の結果インターフェース
 */
export interface MatchResult {
	/** ソースセクションとマッチしたターゲットセクション */
	matches: Array<{
		source: MdaitSection;
		target: MdaitSection;
	}>;
	/** マッチしなかったソースセクション (新規または変更) */
	unmatchedSources: MdaitSection[];
	/** マッチしなかったターゲットセクション (削除または孤立) */
	unmatchedTargets: MdaitSection[];
}

/**
 * セクション対応処理を行うクラス
 */
export class SectionMatcher {
	/**
	 * ソースと対象のセクション対応付けを行う
	 * @param sourceSections ソースのセクション配列
	 * @param targetSections 対象のセクション配列
	 */
	match(
		sourceSections: MdaitSection[],
		targetSections: MdaitSection[],
	): MatchResult {
		const matches: Array<{ source: MdaitSection; target: MdaitSection }> = [];
		const unmatchedTargets = [...targetSections];
		const unmatchedSources: MdaitSection[] = [];

		// 対応付けの状態追跡用マップ
		const processedSourceHashes = new Set<string>();
		const processingSourceHashes = new Set<string>();

		// dupicate src warning
		const srcHashCount = new Map<string, number>();
		for (const target of targetSections) {
			const srcHash = target.getSourceHash();
			if (srcHash) {
				srcHashCount.set(srcHash, (srcHashCount.get(srcHash) || 0) + 1);
			}
		}

		// 警告出力（重複src）
		srcHashCount.forEach((count, hash) => {
			if (count > 1) {
				console.warn(
					`Warning: Source hash "${hash}" appears ${count} times in target file. Only the first occurrence will be matched.`,
				);
			}
		});

		// 各ソースセクションに対して対応するターゲットを探す
		for (const source of sourceSections) {
			// ソースセクションのハッシュを計算
			const sourceHash = calculateHash(source.content);

			// 循環参照チェック
			if (processingSourceHashes.has(sourceHash)) {
				console.error(`Circular reference detected for hash: ${sourceHash}`);
				continue;
			}

			// 既に処理済みのハッシュはスキップ
			if (processedSourceHashes.has(sourceHash)) {
				continue;
			}

			processingSourceHashes.add(sourceHash);

			// ターゲットのsrcハッシュが一致するものを探す
			const targetIndex = unmatchedTargets.findIndex(
				(target) => target.getSourceHash() === sourceHash,
			);

			if (targetIndex !== -1) {
				// マッチが見つかった場合
				const target = unmatchedTargets[targetIndex];

				// マッチをリストに追加
				matches.push({ source, target });

				// マッチしたターゲットをunmatchedから削除
				unmatchedTargets.splice(targetIndex, 1);
			} else {
				// マッチが見つからない場合、新規セクション
				unmatchedSources.push(source);
			}

			// 処理完了マーク
			processedSourceHashes.add(sourceHash);
			processingSourceHashes.delete(sourceHash);
		}

		return {
			matches,
			unmatchedSources,
			unmatchedTargets,
		};
	}

	/**
	 * 同期結果からターゲットセクションの配列を生成
	 * @param matchResult セクション対応の結果
	 * @param autoDeleteOrphans 孤立セクションを自動削除するかどうか
	 */
	createSyncedTargets(
		matchResult: MatchResult,
		autoDeleteOrphans = true,
	): MdaitSection[] {
		const result: MdaitSection[] = [];
		const { matches, unmatchedSources, unmatchedTargets } = matchResult;

		// source順にセクションを配置
		for (const { source, target } of matches) {
			const sourceHash = calculateHash(source.content);

			// ハッシュが変わっていれば更新
			if (target.mdaitHeader && target.mdaitHeader.hash !== sourceHash) {
				target.mdaitHeader.updateHash(sourceHash);
			}

			result.push(target);
		}

		// 新規セクションの作成と挿入
		for (const source of unmatchedSources) {
			const sourceHash = calculateHash(source.content);
			const newTarget = MdaitSection.createEmptyTargetSection(
				source,
				sourceHash,
			);
			result.push(newTarget);
		}

		// 孤立セクション（マッチしなかったターゲット）の処理
		if (!autoDeleteOrphans) {
			// 削除せずに保持、need:verify-deletionタグを付与
			for (const orphan of unmatchedTargets) {
				if (orphan.mdaitHeader) {
					orphan.mdaitHeader.needTag = "verify-deletion";
				} else {
					const hash = calculateHash(orphan.content);
					orphan.mdaitHeader = new MdaitHeader(hash, null, "verify-deletion");
				}
				result.push(orphan);
			}
		}

		return result;
	}
}
