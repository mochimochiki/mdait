import type { FileHandler } from "./file-handler";
import { resolveFileType } from "./file-type";
import { MdFileHandler } from "./md-file-handler";
import { PlainFileHandler } from "./plain-file-handler";

/**
 * ファイルパスに基づいて適切なFileHandlerを返す。
 * ハンドラ選択の唯一の集約点（判定規則そのものは file-type.ts が持つ）。
 */
export function getFileHandler(filePath: string): FileHandler {
	return resolveFileType(filePath) === "md" ? new MdFileHandler() : new PlainFileHandler();
}
