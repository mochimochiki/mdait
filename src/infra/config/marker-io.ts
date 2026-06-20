import type { MarkerFileContext, MarkerProvider } from "../../core/markdown/marker-provider";
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
