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

	/**
	 * ファイルが実在するかを返す。
	 * ステータス更新時に、消えたファイルをツリーから取り除くために使う。
	 * ファイルアクセスを core から追い出すため、存在確認もポート経由にする。
	 */
	fileExists(filePath: string): boolean;
}
