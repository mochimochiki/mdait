/**
 * @file conflict-source.ts
 * @description
 *   `.mdait` の未解決の競合を数える、**唯一の算出点**（roadmap-v04 P01）。
 *
 *   数える場所が2つあると、ステータスバーの数字とツリーの件数が食い違う。ここを通れば
 *   どのサーフェスも同じ入力（ディスクの4ファイルと `unit-state` の行）から同じ答えを得る。
 *   覚え書き（更新時刻と寸法）も1つで済むので、`unit-registry` のような大きなファイルを
 *   サーフェスの数だけ読み直すことも無い。
 *
 * @module ui/status/conflict-source
 */
import { MdaitConflictScanner, type MdaitConflicts, noConflicts } from "../../core/conflict/mdait-conflicts";
import { UnitStateStore } from "../../core/unit-state/unit-state-store";
import type { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";

const scanner = new MdaitConflictScanner();

/**
 * いまワークスペースに残っている未解決の競合を数える。
 *
 * 選択中の transPair で絞らない。`.mdait` のファイルはワークスペースに1つずつで言語ペアに
 * 属さないし、**競合を数え落とすより、選択の外のものまで見せるほうが安全**だからである。
 */
export function collectWorkspaceConflicts(configuration: Configuration): MdaitConflicts {
	if (!configuration.isConfigured()) {
		return noConflicts();
	}
	try {
		return scanner.scan(
			{
				unitState: configuration.getUnitStateFilePath(),
				unitRegistry: configuration.getUnitRegistryFilePath(),
				tm: configuration.getTmFilePath(),
				terms: configuration.getTermsFilePath(),
			},
			UnitStateStore.getInstance().getAllEntries(),
		);
	} catch (error) {
		// 設定が半端な作業場ではパスが引けない。「数えられなかった」と「競合が無い」は
		// 違うが、ここで投げるとツリーもステータスバーも丸ごと描けなくなる
		Logger.getInstance().debug("conflicts", "failed to count .mdait conflicts", formatError(error));
		return noConflicts();
	}
}

/** 覚え書きを捨てて、次に数えるときは必ずファイルを読み直させる */
export function invalidateWorkspaceConflicts(): void {
	scanner.invalidate();
}
