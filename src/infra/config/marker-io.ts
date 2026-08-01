import type { MarkerFileContext, MarkerProvider } from "../../core/markdown/marker-provider";
import { FileExplorer } from "../workspace/file-explorer";
import { toWorkspaceRelativePath } from "../workspace/workspace-path";
import type { Configuration } from "./configuration";

/**
 * parse/stringify に渡す MarkerProvider と MarkerFileContext の組。
 */
export interface MarkerIO {
	provider: MarkerProvider;
	/** external のときのみファイルコンテキストを持つ（embedded では undefined） */
	ctx: MarkerFileContext | undefined;
}

/**
 * 管理下ファイルの読み書きに使う MarkerProvider と ctx を解決する。
 *
 * embedded（既定）では provider=embedded・ctx=undefined となり、
 * `parse(content, config)` 相当（＝現状の挙動）になる。
 * external では provider=external・ctx に「ワークスペース相対パス + role」を詰める。
 *
 * @param config Configuration（モード判定に使用）
 * @param absPath 対象ファイルの絶対パス
 * @param role source / target（external で from の扱いを分けるため）
 */
export function resolveMarkerIO(config: Configuration, absPath: string, role: "source" | "target"): MarkerIO {
	const provider = config.getMarkerProvider();
	const ctx = config.isExternalMarkers() ? { filePath: toWorkspaceRelativePath(absPath), role } : undefined;
	return { provider, ctx };
}

/**
 * role を FileExplorer で自動判定して MarkerIO を解決する。
 *
 * 呼び出し側の文脈から source / target が自明でない（あるいはどちらも来うる）
 * parse サイト向けの薄い便宜ラッパー。判定不能（ワークスペース未設定等）は
 * target 扱いにフォールバックする（現状 role は文脈提示用であり挙動を変えない）。
 *
 * 管理下 Markdown を parse する箇所は必ず本関数か resolveMarkerIO を通すこと。
 * 素の `markdownParser.parse(content, config)` は external モードでマーカーを
 * 見失い、「マーカー無しファイル」として静かに誤動作する。
 */
export function resolveMarkerIOForFile(config: Configuration, absPath: string): MarkerIO {
	let role: "source" | "target" = "target";
	try {
		role = new FileExplorer().isSourceFile(absPath, config) ? "source" : "target";
	} catch {
		// ワークスペース未設定などの判定不能時は target 扱い
	}
	return resolveMarkerIO(config, absPath, role);
}
