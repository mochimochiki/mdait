import { Logger } from "../../infra/logging/logger";
import { calculateHash } from "../hash/hash-calculator";
import { UnitStateStore } from "../unit-state/unit-state-store";
import { MdaitMarker } from "./mdait-marker";
import type { MdaitUnit } from "./mdait-unit";

const logger = Logger.getInstance();

/**
 * マーカーの保管先を解決するためのファイルコンテキスト
 *
 * external では対象ファイルのパスをキーに外部ストアを引くため必要になる。
 * embedded（既定）では未使用。
 */
export interface MarkerFileContext {
	/** 対象ファイルの絶対パス（external でストア検索に使う。embedded では未使用） */
	filePath?: string;
	/** "source" | "target"（現状は両ロール同一処理。呼び出し側の文脈提示用） */
	role?: "source" | "target";
}

/**
 * マーカーの「出し入れ口」を抽象化する Strategy。
 *
 * 埋め込みマーカーは「境界生成」と「物理追従」を密結合で担っている。
 * パーサー内部に if 分岐を増やさず、マーカーの永続化方式を差し替えられるよう、
 * parse/stringify にこの Provider を注入する。
 *
 * - embedded（既定）: マーカーは本文に埋め込まれるため attach/detach は no-op。
 * - external: 外部ストア `.mdait/unit-state` と attach/detach で橋渡しする。
 */
export interface MarkerProvider {
	readonly mode: "embedded" | "external";
	/** 境界生成にマーカーを使うか（embedded=true, external=false） */
	readonly markersFormBoundaries: boolean;
	/** parse 後: 外部由来マーカーをユニットに後付けする（embedded は no-op） */
	attachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void;
	/** stringify 前: ユニットからマーカーを引き取り永続化する（embedded は no-op） */
	detachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void;
}

/**
 * 既定の埋め込みマーカー Provider。
 *
 * マーカーは本文に埋め込まれている前提のため、attach/detach は何もしない。
 * stringify 時の埋め込みは MdaitUnit.toString() が担う（現行どおり）。
 */
export class EmbeddedMarkerProvider implements MarkerProvider {
	readonly mode = "embedded" as const;
	readonly markersFormBoundaries = true;

	attachMarkers(): void {
		/* no-op: マーカーは本文に埋め込み済み */
	}

	detachMarkers(): void {
		/* no-op: MdaitUnit.toString() が埋め込む */
	}
}

/**
 * 既定で使用する埋め込み Provider のシングルトンインスタンス。
 */
export const embeddedMarkerProvider: MarkerProvider = new EmbeddedMarkerProvider();

/**
 * 外部ストア（`.mdait/unit-state`）とユニットを橋渡しする Provider。
 *
 * - マーカーは本文に埋め込まず、`UnitStateStore` に `(path, order)` キーで保管する。
 * - attach: store のエントリを order 昇順で取得し、ユニット配列 index（=order）を主キーに
 *   マーカーを後付けする。titleHash は補助検証のみ（不一致でも index マッチを採用）。
 * - detach: 各ユニットを order=index でストアに書き込む（save は呼ばない。sync 完了時に1回）。
 *
 * `ctx.filePath` はワークスペース相対・/区切りを契約とする（正規化は呼び出し側の責務）。
 */
export class ExternalMarkerProvider implements MarkerProvider {
	readonly mode = "external" as const;
	readonly markersFormBoundaries = false;

	/**
	 * @param storeOverride テスト用に注入するストア。未指定時は呼び出しごとに
	 *   `UnitStateStore.getInstance()` を解決する（dispose 後の差し替えにも追従する）。
	 */
	constructor(private readonly storeOverride?: UnitStateStore) {}

	/** 実際に使用するストア（注入があればそれ、無ければ現行シングルトン） */
	private get store(): UnitStateStore {
		return this.storeOverride ?? UnitStateStore.getInstance();
	}

	attachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void {
		const filePath = ctx?.filePath;
		if (!filePath) {
			return;
		}
		const entries = this.store.getEntriesByPath(filePath);
		for (let i = 0; i < units.length; i++) {
			const entry = entries[i];
			if (!entry) {
				// エントリ不足: マーカー不在のまま（sync が need 判定で自己修復）
				continue;
			}
			// titleHash は補助検証のみ。不一致でも index マッチを採用する
			const expected = calculateHash(units[i].title);
			if (entry.titleHash && entry.titleHash !== expected) {
				logger.debug("marker", "titleHash mismatch (index match used)", {
					path: filePath,
					order: i,
					expected,
					stored: entry.titleHash,
				});
			}
			units[i].marker = new MdaitMarker(entry.hash, entry.from || null, entry.need || null);
		}
	}

	detachMarkers(units: MdaitUnit[], ctx?: MarkerFileContext): void {
		const filePath = ctx?.filePath;
		if (!filePath) {
			return;
		}
		for (let i = 0; i < units.length; i++) {
			const unit = units[i];
			this.store.setEntry({
				path: filePath,
				order: i,
				level: unit.headingLevel,
				titleHash: calculateHash(unit.title),
				hash: unit.marker?.hash ?? "",
				from: unit.marker?.from ?? "",
				need: unit.marker?.need ?? "",
			});
		}
		// store.save() は呼ばない。sync 完了時に1回だけ保存する。
	}
}

/**
 * 既定で使用する外部 Provider のシングルトンインスタンス。
 */
export const externalMarkerProvider: MarkerProvider = new ExternalMarkerProvider();
