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
import type { PreparedResolution } from "../../commands/conflict/resolve-core";
import { prepareResolution } from "../../commands/conflict/resolve-core";
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

/**
 * いま人の判断を待っている件の一覧（ツリーが1件1行で並べるために使う）。
 *
 * 計画を作るのはファイルを読む仕事なので、**競合の見た目が動いていないあいだは作り直さない**。
 * 動いていたら作り直す — 別の合流が来たか、人が手で直したかのどちらかで、前の計画の鍵は
 * もう当てにならない。
 *
 * **1バイトも書かない。** `prepareResolution` は読むだけである。
 */
export async function collectPendingChoices(configuration: Configuration): Promise<PreparedResolution | undefined> {
	const conflicts = collectWorkspaceConflicts(configuration);
	if (conflicts.files.length === 0) {
		preparedCache = undefined;
		preparedStamp = undefined;
		return undefined;
	}
	// 覚え書きの鍵は「いま競合しているファイルとその見た目」。**パスだけでは足りない** —
	// 別の合流が来ても人が手で直しても、競合しているファイルの並びは変わらないことがある。
	// 中身が動いたのに前の計画を返すと、古い値をそのまま書き戻しうる
	const stamp = conflicts.files.map((file) => file.stamp).join("\u0000");
	if (preparedCache && preparedStamp === stamp && !preparedDirty) {
		return preparedCache;
	}
	try {
		preparedCache = await prepareResolution(conflicts, configuration);
		preparedStamp = stamp;
		preparedDirty = false;
		return preparedCache;
	} catch (error) {
		// 作り直せなかった。**前の計画を残さない** — 残すと、次に同じ見た目で聞かれたときに
		// 古い計画を返してしまう
		Logger.getInstance().debug("conflicts", "failed to prepare a resolution", formatError(error));
		preparedCache = undefined;
		preparedStamp = undefined;
		preparedDirty = true;
		return undefined;
	}
}

let preparedCache: PreparedResolution | undefined;
let preparedStamp: string | undefined;
let preparedDirty = true;

/** 覚え書きを捨てて、次に数えるときは必ずファイルを読み直させる */
export function invalidateWorkspaceConflicts(): void {
	scanner.invalidate();
	preparedCache = undefined;
	preparedStamp = undefined;
	preparedDirty = true;
}
