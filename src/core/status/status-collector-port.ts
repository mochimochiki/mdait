import type { FileStatusItem } from "./status-item";
import type { StatusItemTree } from "./status-item-tree";

/**
 * ファイルステータス収集のポートインターフェース（Core層）
 * Commands層のStatusCollectorがこのインターフェースを実装する。
 */
export interface StatusCollectorPort {
	/** 単一ファイルの翻訳状況を収集する */
	collectFileStatus(filePath: string): Promise<FileStatusItem>;

	/** 全ファイルをスキャンしてStatusItemTreeを構築する */
	buildStatusItemTree(): Promise<StatusItemTree>;
}
