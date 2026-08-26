/**
 * @file markers-migration.ts
 * @description
 *   マーカー保管方式を一括変換するコマンド。
 *   - externalize: 本文の埋め込みマーカーを `.mdait/unit-state` へ退避（embedded → external）
 *   - embed: unit-state のマーカーを本文へ書き戻す（external → embedded）
 *   externalize は「embedded parse → マーカー除去本文を external 境界で再 parse →
 *   (headingLevel, title) 部分列一致でマーカー移送 → external stringify（store へ detach）」、
 *   embed は「external parse（store から attach）→ embedded stringify」で行い、
 *   完了後に mdait.json の markers.mode を整形保持で更新する（ADR-260731-03）。
 * @module commands/markers/markers-migration
 */
import * as fs from "node:fs";
import * as vscode from "vscode";
import { FrontMatter } from "../../core/markdown/front-matter";
import { FRONTMATTER_MARKER_KEY, parseFrontmatterMarker } from "../../core/markdown/frontmatter-translation";
import { markdownParser } from "../../core/markdown/parser";
import { StatusManager } from "../../core/status/status-manager";
import { embeddedMarkerProvider, externalMarkerProvider } from "../../core/markdown/marker-provider";
import { alignEntriesToUnits } from "../../core/unit-state/unit-state-align";
import type { UnitStateEntry } from "../../core/unit-state/unit-state-store";
import { UnitStateStore, isHeldBackEntry } from "../../core/unit-state/unit-state-store";
import { setConfigValue } from "../../infra/config/config-json-editor";
import { Configuration } from "../../infra/config/configuration";
import { Logger, formatError } from "../../infra/logging/logger";
import { FileExplorer } from "../../infra/workspace/file-explorer";
import { flushDirtyDocument } from "../../infra/workspace/dirty-document";
import { ensureMdaitDir } from "../../infra/workspace/mdait-dir";
import { toWorkspaceRelativePath } from "../../infra/workspace/workspace-path";

const logger = Logger.getInstance();

/**
 * sync の自己修復（reconcile）で「sync.level 0 のため外部化しなかった」警告を出したファイル。
 * sync のたびに同じ警告を繰り返さないためのセッション内の記録。
 */
const levelZeroExternalizeWarned = new Set<string>();

/** 変換対象の MD ファイル（絶対パス + ロール） */
export interface MigrationTarget {
	absPath: string;
	role: "source" | "target";
}

/** per-file 変換の結果 */
export interface MigrateFileResult {
	/** ファイル内容が実際に書き換わったか */
	changed: boolean;
	/** 移送されたマーカー数（hash を持つユニット） */
	unitsMigrated: number;
	/** externalize で失われたサブユニット境界マーカー数（embed では常に 0） */
	unitsDropped: number;
}

/**
 * 単一 MD ファイルの埋め込みマーカーを外部ストアへ退避する（embedded → external）。
 *
 * embedded parse のユニット列には「見出しを伴わないマーカー単独境界」や
 * 「閾値より深い見出しに統合されたマーカー」のサブユニットが含まれうるが、
 * external parse の境界は見出しレベルのみで決まるため、embedded の order を
 * そのまま store に書くと external 側の order と食い違い、後続ユニットに
 * ずれたマーカーが attach される（状態の取り違え）。
 * これを防ぐため、マーカー除去後の本文を external 境界で再 parse し、
 * (headingLevel, title) の部分列一致で embedded 側のマーカーを移送してから
 * store へ書き込む。external 境界に対応しないマーカーは仕様どおり失われる
 * （実行前の確認ダイアログで警告済み）。
 *
 * store.save() は呼ばない（一括実行の完了時に1回保存する）。
 */
export function externalizeFileMarkers(
	absPath: string,
	role: "source" | "target",
	config: Configuration,
): MigrateFileResult {
	const content = fs.readFileSync(absPath, "utf-8");
	const relPath = toWorkspaceRelativePath(absPath);
	const embeddedParsed = markdownParser.parse(content, config, embeddedMarkerProvider);

	// ctx を渡さない external stringify はマーカーを保存せず本文から除去するだけ（detach は no-op）。
	// その結果を external 境界で再 parse して「外部化後のユニット列」を確定させる。
	const strippedBody = markdownParser.stringify(embeddedParsed, externalMarkerProvider);
	const externalParsed = markdownParser.parse(strippedBody, config, externalMarkerProvider);

	// embedded 側のマーカーを (headingLevel, title) の部分列一致で移送する
	let cursor = 0;
	let unitsMigrated = 0;
	for (const unit of externalParsed.units) {
		let matched = -1;
		for (let k = cursor; k < embeddedParsed.units.length; k++) {
			const candidate = embeddedParsed.units[k];
			if (candidate.headingLevel === unit.headingLevel && candidate.title === unit.title) {
				matched = k;
				break;
			}
		}
		if (matched < 0) {
			// 対応が見つからない場合はマーカー無しのまま（sync の need 判定で自己修復される）
			continue;
		}
		const marker = embeddedParsed.units[matched].marker;
		cursor = matched + 1;
		if (marker?.hash) {
			unit.marker = marker;
			unitsMigrated++;
		}
	}
	const totalWithHash = embeddedParsed.units.filter((u) => Boolean(u.marker?.hash)).length;
	const unitsDropped = totalWithHash - unitsMigrated;
	if (unitsDropped > 0) {
		logger.info("markers", "Sub-unit boundary markers dropped during externalize (not supported in external mode)", {
			file: relPath,
			dropped: unitsDropped,
		});
	}

	// ctx 付きの external stringify で store へ detach（order は external 境界のユニット列と一致）
	const out = markdownParser.stringify(externalParsed, externalMarkerProvider, { filePath: relPath, role });
	const changed = out !== content;
	if (changed) {
		fs.writeFileSync(absPath, out, "utf-8");
	}
	return { changed, unitsMigrated, unitsDropped };
}

/**
 * 単一 MD ファイルへ外部ストアのマーカーを書き戻す（external → embedded）。
 *
 * 書き戻せた行だけを store から消す。**本文に書き戻せなかった行は残す。**
 * 本文のユニットと行の対応は内容で決まるため（`alignEntriesToUnits`）、行の数だけ
 * ユニットがあるとは限らない。対応の付かなかった行を一緒に消すと、その `from`/`need` は
 * 本文にも store にも残らず、復旧手段が無くなる。
 *
 * 「消せなかった行があるならファイル単位で削除を見送る」案も採れるが、そうすると
 * 書き戻し済みの行まで残り、本文（＝これ以降の正）と二重に持つことになる。二重に持った
 * 状態は embedded 運用のあいだ静かに古くなるので、残すのは「本文に居場所の無い行」だけにする。
 *
 * store.save() は呼ばない（一括実行の完了時に1回保存する）。
 */
export function embedFileMarkers(
	absPath: string,
	role: "source" | "target",
	config: Configuration,
	store: UnitStateStore,
): MigrateFileResult {
	const content = fs.readFileSync(absPath, "utf-8");
	const relPath = toWorkspaceRelativePath(absPath);
	const entries = store.getEntriesByPath(relPath);
	const parsed = markdownParser.parse(content, config, externalMarkerProvider, { filePath: relPath, role });

	// parse の attach と同じ対応表を作り直す（同じ入力に対する純粋関数なので同じ結果になる）。
	// どの行がどのユニットへ書き戻されたかを知るために要る。
	// 「位置を信用しない行」も attach と同一でなければ対応表がずれる。
	const untrusted = new Set<number>();
	for (let i = 0; i < entries.length; i++) {
		if (isHeldBackEntry(entries[i])) {
			untrusted.add(i);
		}
	}
	const aligned = alignEntriesToUnits(entries, parsed.units, untrusted);
	const embeddedEntries = new Set<UnitStateEntry>();

	// 外部ストアの frontmatter マーカーを本文側の表現へ戻す。
	// `attachFrontMatter` が「置き場所は外部」と印を付けているので、外さないと
	// `stringify` がこのキーを書き出さず、マーカーが黙って消える。
	// frontmatter そのものが無いファイルには書き戻す先が無いので、行を残す
	// （消す側の失敗は取り返しがつかない）。
	const frontEntry = store.getFrontMatterEntry(relPath);
	const frontEmbedded = Boolean(frontEntry && parsed.frontMatter);
	if (frontEmbedded) {
		parsed.frontMatter?.unmarkExternalKey(FRONTMATTER_MARKER_KEY);
	} else if (frontEntry) {
		logger.warn("markers", "Kept the frontmatter unit-state entry: the file has no frontmatter to write it back into", {
			file: relPath,
		});
	}

	// store にエントリの無いユニット（本文のユニット数がエントリ数より多い場合など）には
	// マーカー行を出力しない。hash 空のままだと本文へ空スタブ `<!-- mdait -->` が
	// 書き込まれてしまう。マーカーは次回 sync が正しく付与する（自己修復）。
	for (let i = 0; i < parsed.units.length; i++) {
		const unit = parsed.units[i];
		if (!unit.marker?.hash) {
			(unit as { marker: unknown }).marker = undefined;
			continue;
		}
		const entry = aligned[i];
		if (entry) {
			embeddedEntries.add(entry);
		}
	}
	const unitsMigrated = embeddedEntries.size;

	const out = markdownParser.stringify(parsed, embeddedMarkerProvider);
	const changed = out !== content;
	if (changed) {
		fs.writeFileSync(absPath, out, "utf-8");
	}

	if (frontEmbedded) {
		store.removeFrontMatterEntry(relPath);
	}

	const orphanedEntries = entries.filter((e) => !embeddedEntries.has(e));
	for (const entry of entries) {
		if (embeddedEntries.has(entry)) {
			store.removeEntry(relPath, entry.order);
		}
	}
	// 抑制はしない。「一度出したら二度と出さない」にすると、原因を直したのにまた起きたときに
	// 気づけなくなる（記録用の Set も解放されず増え続ける）。出力チャネルのログなので
	// 繰り返しても人の作業は止めない
	if (orphanedEntries.length > 0) {
		logger.warn(
			"markers",
			"Kept unit-state entries that could not be written back into the file (no matching unit in the body)",
			{ file: relPath, kept: orphanedEntries.length, orders: orphanedEntries.map((e) => e.order) },
		);
	}
	return { changed, unitsMigrated, unitsDropped: 0 };
}

/**
 * 単一 MD ファイルの物理マーカー表現を、設定中の `markers.mode` へ自己修復的に整合させる。
 *
 * 「本文マーカーで運用していたサイトを external に切り替える（またはその逆）」動線では、
 * ユーザーは `markers.externalize`/`embed` コマンドを明示実行せず、mdait.json の
 * `markers.mode` を書き換えて sync するだけの場合がある。その状態で sync すると、
 * - embedded→external: 本文に埋め込みマーカーが残ったまま external parse され、
 *   毎 sync ごとに先頭マーカー後へ空行が増える非冪等成長が起きる。
 * - external→embedded: 本文にマーカーが無いため全ユニットが新規扱いになり、
 *   from/need 状態を失って不要な再翻訳が誘発される。
 * を防ぐため、sync の各ファイル処理前に本関数で物理表現をモードへ寄せる。
 *
 * 変換は per-file の migrate と同一（embedded parse ⇄ external parse + 反対 provider stringify）。
 * 既に目標モードの表現ならファイルへ書き込まず `false` を返す（冪等・低コスト）。
 * store の save は呼ばない（sync 完了時に1回まとめて保存される）。
 *
 * @returns 物理変換を行い書き込んだ場合 true、no-op なら false
 */
export function reconcileMarkerModeForFile(
	absPath: string,
	role: "source" | "target",
	config: Configuration,
	store: UnitStateStore,
): boolean {
	const content = fs.readFileSync(absPath, "utf-8");
	const relPath = toWorkspaceRelativePath(absPath);

	if (config.isExternalMarkers()) {
		// 目標: 本文に unit マーカーが無い。埋め込み残存を検出したら externalize する。
		// 安価な事前判定。ここを通ると markdown-it の全解析に入るので、字面で確実に絞る。
		// **frontmatter マーカーも外部化の対象**なので、HTML コメントだけを見て抜けると
		// 原文にマーカーが残ったままになる（P05）。
		//
		// ただし `mdait:` だけを見てはいけない。`mdait.sync.level`（ファイル別の見出し
		// レベル指定）を書いただけのファイルが毎 sync で全解析に入る。frontmatter
		// マーカーは必ず `front:` を伴うので、両方の字面がある場合だけ先へ進める。
		const mayHaveUnitMarker = content.includes("<!-- mdait");
		const mayHaveFrontMarker = content.includes("mdait:") && content.includes("front:");
		if (!mayHaveUnitMarker && !mayHaveFrontMarker) {
			return false;
		}
		// コードブロック内のサンプルマーカーは境界にならないため、権威判定は parse 結果で行う。
		const parsed = markdownParser.parse(content, config, embeddedMarkerProvider);
		const hasUnitMarker = parsed.units.some((u) => Boolean(u.marker?.hash));
		const hasFrontMarker = Boolean(parseFrontmatterMarker(parsed.frontMatter));
		if (!hasUnitMarker && !hasFrontMarker) {
			return false;
		}
		// 実効 sync.level が 0（完全手動マーカー配置。frontmatter の mdait.sync.level 上書きを含む）の
		// ファイルは、見出しベース境界しか表現できない external モードへ外部化すると手動マーカーが
		// 失われる。自己修復ではデータを破壊せず、ファイルを触らないまま警告のみ残す
		// （markers.mode と sync.level の設定不整合そのものは doctor 診断が表面化する）。
		const effectiveLevel = parsed.frontMatter?.get("mdait.sync.level") ?? config.sync?.level;
		if (effectiveLevel === 0) {
			if (!levelZeroExternalizeWarned.has(relPath)) {
				levelZeroExternalizeWarned.add(relPath);
				logger.warn(
					"markers",
					"Skipping externalize during sync: effective sync.level is 0 (fully manual marker placement) — externalizing would destroy manual markers. Run doctor for the config mismatch.",
					{ file: relPath },
				);
			}
			return false;
		}
		const result = externalizeFileMarkers(absPath, role, config);
		logger.info("markers", "Reconciled file to external mode during sync", {
			file: relPath,
		});
		return result.changed;
	}

	// 目標: 本文に unit マーカーがある（embedded）。
	// store に本ファイルのエントリが在る＝直前まで external だった痕跡。
	// かつ本文にマーカーが無い場合のみ embed（本文にマーカーが在れば既に embedded 済み）。
	const entries = store.getEntriesByPath(relPath);
	const frontEntry = store.getFrontMatterEntry(relPath);
	if (entries.length === 0 && !frontEntry) {
		return false;
	}
	const embeddedParse = markdownParser.parse(content, config, embeddedMarkerProvider);
	if (embeddedParse.units.some((u) => Boolean(u.marker?.hash))) {
		return false;
	}
	if (embeddedParse.units.length === 0 && !(frontEntry && embeddedParse.frontMatter)) {
		// 本文にも frontmatter にも書き戻す先が無い。ここで抜けないと、行が残る限り
		// この条件は永久に真のままで、sync のたびに parse + 突き合わせ + stringify を空回りする
		return false;
	}
	const result = embedFileMarkers(absPath, role, config, store);
	logger.info("markers", "Reconciled file to embedded mode during sync", {
		file: relPath,
	});
	return result.changed;
}

/**
 * 埋め込みマーカーを外部ストアへ退避する（embedded → external）。
 */
export async function externalizeMarkersCommand(): Promise<void> {
	await migrateMarkers("external");
}

/**
 * 外部ストアのマーカーを本文へ書き戻す（external → embedded）。
 */
export async function embedMarkersCommand(): Promise<void> {
	await migrateMarkers("embedded");
}

/**
 * 管理下の全 MD ファイル（source / target）を収集する。
 * 非MDファイルは対象外（unit-state の order:0 エントリは変換しない）。
 */
async function collectMarkdownTargets(config: Configuration): Promise<MigrationTarget[]> {
	const explorer = new FileExplorer();
	const targets: MigrationTarget[] = [];
	const seen = new Set<string>();
	const add = (absPath: string, role: "source" | "target") => {
		if (seen.has(absPath)) {
			return;
		}
		seen.add(absPath);
		targets.push({ absPath, role });
	};

	for (const pair of config.transPairs) {
		// .md のみ（extensions は渡さない）
		const sources = await explorer.getSourceFiles(pair.sourceDir, config);
		for (const src of sources) {
			add(src, "source");
			const tgt = explorer.getTargetPath(src, pair);
			if (tgt && fs.existsSync(tgt)) {
				add(tgt, "target");
			}
		}
	}
	return targets;
}

/**
 * frontmatter の `mdait.sync.level: 0`（完全手動マーカー運用のファイル別上書き）を持つ
 * ファイル数を数える。external モードは手動サブユニット境界を表現できないため、
 * externalize の事前スキャンで対象数を警告に含める。読めないファイルは 0 扱い。
 */
export function countManualSyncLevelZeroFiles(absPaths: readonly string[]): number {
	let count = 0;
	for (const absPath of absPaths) {
		try {
			const { frontMatter } = FrontMatter.parse(fs.readFileSync(absPath, "utf-8"));
			if (frontMatter?.get("mdait.sync.level") === 0) {
				count++;
			}
		} catch {
			// 読めないファイルは対象外扱い（変換時に別途エラーになる）
		}
	}
	return count;
}

/** 一括変換ループの結果 */
export interface MigrationLoopResult {
	filesRewritten: number;
	unitsMigrated: number;
	/**
	 * 移せずに落としたマーカーの数（externalize のみ）。
	 * 落とすと `from` と `need` も一緒に消える。**必ず表に出すこと。**
	 */
	unitsDropped: number;
	cancelled: boolean;
}

/**
 * 一括変換の中核ループ。対象ファイルを順に per-file 変換し、最後に store を保存する。
 *
 * store の保存は try/finally で行い、途中のファイルで例外が起きても必ず実行する。
 * externalize は per-file 変換の時点で本文からマーカーを除去済みであり、その状態は
 * store（メモリ上）にしか無い。保存せずに次の sync が store.load() すると、変換済み
 * ファイルのマーカーが失われて復元不能になる（キャンセル時も同様の理由で保存する）。
 * markers.mode の切替はここでは行わない（完全成功時のみ呼び出し側が行う）。
 */
export async function runMigrationLoop(
	targets: readonly MigrationTarget[],
	toExternal: boolean,
	config: Configuration,
	store: UnitStateStore,
	mdaitDir: string | null | undefined,
	token?: vscode.CancellationToken,
	progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<MigrationLoopResult> {
	let filesRewritten = 0;
	let unitsMigrated = 0;
	let unitsDropped = 0;
	let cancelled = false;
	try {
		for (let i = 0; i < targets.length; i++) {
			if (token?.isCancellationRequested) {
				cancelled = true;
				break;
			}
			const { absPath, role } = targets[i];
			progress?.report({
				message: vscode.l10n.t("{0}/{1} files", i + 1, targets.length),
				increment: 100 / targets.length,
			});

			// 開いているエディタの未保存変更を反映してから読み込む
			await flushDirtyDocument(absPath);
			const result = toExternal
				? externalizeFileMarkers(absPath, role, config)
				: embedFileMarkers(absPath, role, config, store);
			if (result.changed) {
				filesRewritten++;
			}
			unitsMigrated += result.unitsMigrated;
			unitsDropped += result.unitsDropped;
		}
	} finally {
		// store を保存（external: 追加した detach、embedded: 削除を永続化）。
		// 正常終了・キャンセル・途中の例外を含む全ての経路で必ず保存する。
		if (mdaitDir) {
			store.save(mdaitDir);
		}
	}
	return { filesRewritten, unitsMigrated, unitsDropped, cancelled };
}

/**
 * マーカー保管方式を一括変換する中核処理。
 * @param toMode 変換先のモード
 */
async function migrateMarkers(toMode: "embedded" | "external"): Promise<void> {
	const config = Configuration.getInstance();
	if (!config.isConfigured()) {
		vscode.window.showErrorMessage(vscode.l10n.t("mdait is not configured in this workspace."));
		return;
	}

	const toExternal = toMode === "external";

	// sync.level 0（完全手動マーカー配置）は見出しに紐づかない境界を許すが、
	// external モードは見出しベースの境界しか表現できず、外部化するとマーカーが失われる。
	// グローバル設定が 0 の場合は非互換としてブロックする（ADR-260801-01）
	if (toExternal && config.sync?.level === 0) {
		vscode.window.showErrorMessage(
			vscode.l10n.t(
				"Cannot externalize markers: sync.level is 0 (fully manual marker placement). External marker mode stores markers by heading-based unit order and cannot represent manual unit boundaries, so externalizing would lose them. Set sync.level to 1 or higher first.",
			),
		);
		return;
	}

	// 対象ファイルを先に数え、確認ダイアログで「何ファイル書き換わるか」を具体的に示す
	const targets = await collectMarkdownTargets(config);
	if (targets.length === 0) {
		vscode.window.showInformationMessage(vscode.l10n.t("No managed Markdown files found. Nothing to convert."));
		return;
	}

	// frontmatter の mdait.sync.level: 0 上書きを持つファイルは同様にマーカーが失われるため、
	// 件数を確認ダイアログに含め、明示的な確認を経てのみ続行する
	const manualLevelFiles = toExternal ? countManualSyncLevelZeroFiles(targets.map((t) => t.absPath)) : 0;

	const confirmLabel = toExternal
		? vscode.l10n.t("Externalize markers")
		: vscode.l10n.t("Embed markers");
	// adopt の確認と同じ「短い質問 + detail 箇条書き」形式（ADR-260705-01 の確認UI規約）
	const question = toExternal
		? vscode.l10n.t("Externalize markers (embedded → external)?")
		: vscode.l10n.t("Embed markers (external → embedded)?");
	const detailLines = [
		vscode.l10n.t("• {0} managed Markdown file(s) will be rewritten", targets.length),
		toExternal
			? vscode.l10n.t("• Markers move out of the files into .mdait/unit-state")
			: vscode.l10n.t("• Markers in .mdait/unit-state are written back into the files"),
	];
	if (toExternal) {
		// 実測では、落ちるのは「見出しを伴わないマーカー」だけではない。
		// sync.level より深い見出しに付いたマーカーも落ちる（level 3 の既定で #### が落ちた）。
		// 実態と違う説明のまま「警告済み」として扱うのがいちばん危ない
		detailLines.push(
			vscode.l10n.t(
				"• Markers that do not sit on an external unit boundary — deeper than sync.level ({0}), or not on a heading — cannot be moved. They are dropped together with their from/need",
				config.sync?.level ?? 3,
			),
		);
	}
	if (manualLevelFiles > 0) {
		detailLines.push(
			vscode.l10n.t(
				"• Warning: {0} file(s) set 'mdait.sync.level: 0' (fully manual marker placement) in their frontmatter — their markers will be lost",
				manualLevelFiles,
			),
		);
	}
	detailLines.push("", vscode.l10n.t("Committing your workspace to git beforehand is recommended."));

	const choice = await vscode.window.showWarningMessage(
		question,
		{ modal: true, detail: detailLines.join("\n") },
		confirmLabel,
	);
	if (choice !== confirmLabel) {
		return;
	}

	const mdaitDir = await ensureMdaitDir();
	const store = UnitStateStore.getInstance();
	if (mdaitDir) {
		store.ensureLoaded(mdaitDir);
	}

	let filesRewritten = 0;
	let unitsMigrated = 0;
	let unitsDropped = 0;
	let cancelled = false;
	try {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: toExternal
					? vscode.l10n.t("Externalizing mdait markers...")
					: vscode.l10n.t("Embedding mdait markers..."),
				cancellable: true,
			},
			async (progress, token) => {
				// ループ本体は runMigrationLoop に委譲。途中で例外が起きても store の保存は
				// runMigrationLoop の finally が保証する（保存漏れ＝変換済みマーカーの喪失）。
				const loopResult = await runMigrationLoop(targets, toExternal, config, store, mdaitDir, token, progress);
				filesRewritten = loopResult.filesRewritten;
				unitsMigrated = loopResult.unitsMigrated;
				unitsDropped = loopResult.unitsDropped;
				cancelled = loopResult.cancelled;

				// mdait.json の markers.mode を更新（in-memory も即時反映）。
				// キャンセル時（部分変換）はモードを変えず、残りは sync の自己修復に委ねる。
				// ループが例外で中断した場合もここへ達しないため、モードは完全成功時のみ切り替わる。
				if (!cancelled) {
					await setMarkerModeInConfigFile(config, toMode);
				}
			},
		);
	} catch (error) {
		logger.error("markers", "Marker migration failed", formatError(error));
		vscode.window.showErrorMessage(
			vscode.l10n.t("Marker conversion failed: {0}", (error as Error).message),
		);
		return;
	}

	if (cancelled) {
		vscode.window.showWarningMessage(
			vscode.l10n.t("Marker conversion cancelled. Some files may already be converted; re-run to finish."),
		);
		return;
	}

	// モード切替を UI に即時反映する（ステータスツリー再構築 → 変更イベント経由で
	// ツリー・CodeLens・コンテキスト変数がまとめて更新される）。失敗しても変換自体は
	// 成功しているため、完了通知は出す
	try {
		await StatusManager.getInstance().buildStatusItemTree();
	} catch (error) {
		logger.warn("markers", "Failed to refresh status after marker migration", {
			error: (error as Error).message,
		});
	}

	// 落としたマーカーは from と need も一緒に失われる。**必ず表に出す。**
	// これまでは Output の INFO 1行にしか出ておらず、完了通知は「N 件移しました」としか
	// 言わなかった。数十ファイルを一括変換すると、取りこぼしは文書数に比例して増える
	const dropped =
		toExternal && unitsDropped > 0
			? ` ${vscode.l10n.t(
					"{0} marker(s) deeper than sync.level ({1}) could not be moved and were dropped along with their from/need.",
					unitsDropped,
					config.sync?.level ?? 3,
				)}`
			: "";
	const doneMsg = toExternal
		? vscode.l10n.t(
				"Markers externalized: {0} of {1} file(s) rewritten, {2} unit marker(s) moved to .mdait/unit-state. Run Sync to verify the result.",
				filesRewritten,
				targets.length,
				unitsMigrated,
			) + dropped
		: vscode.l10n.t(
				"Markers embedded: {0} of {1} file(s) rewritten, {2} unit marker(s) written back into the files. Run Sync to verify the result.",
				filesRewritten,
				targets.length,
				unitsMigrated,
			);
	if (dropped) {
		vscode.window.showWarningMessage(doneMsg);
	} else {
		vscode.window.showInformationMessage(doneMsg);
	}
}

/**
 * mdait.json の markers.mode を書き換え、in-memory 設定も更新する。
 * 書き換えは共有の setConfigValue 経由で行い、既存のインデント文字・キー順・
 * 末尾改行を保持する（ファイル全体の再整形で git diff を汚さない）。
 * JSON パースに失敗した場合はファイルを変更せず in-memory のみ更新する。
 */
export async function setMarkerModeInConfigFile(config: Configuration, mode: "embedded" | "external"): Promise<void> {
	const configPath = config.getConfigFilePath();
	if (!configPath || !fs.existsSync(configPath)) {
		config.markers.mode = mode;
		return;
	}
	try {
		const raw = fs.readFileSync(configPath, "utf-8");
		fs.writeFileSync(configPath, setConfigValue(raw, ["markers", "mode"], mode), "utf-8");
	} catch (error) {
		logger.warn("markers", "Failed to update markers.mode in mdait.json", formatError(error));
	}
	config.markers.mode = mode;
}
