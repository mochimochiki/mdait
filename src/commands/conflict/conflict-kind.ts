/**
 * @file conflict-kind.ts
 * @description
 *   競合した対象の、人が読む名前。**ここだけが持つ**（ツリーの行・進捗・レポートの
 *   見出しで、同じ対象が違う名前で出ないようにする）。
 *
 * @module commands/conflict/conflict-kind
 */
import * as vscode from "vscode";
import type { ConflictFileKind } from "../../core/conflict/mdait-conflicts";

/** 競合した対象の名前（ツリー・進捗・レポートで共通） */
export function conflictKindLabel(kind: ConflictFileKind): string {
	switch (kind) {
		case "unit-state":
			return vscode.l10n.t("Unit state");
		case "unit-registry":
			return vscode.l10n.t("Source snapshots");
		case "tm":
			return vscode.l10n.t("Translation memory");
		case "terms":
			return vscode.l10n.t("Glossary");
	}
}
