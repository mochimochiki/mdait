// unit-state のテストで使う小道具。
//
// 席のキーは「二度と動かない背番号」なので、テストが 0, 1, 2… と書けなくなった。
// 並び順だけが意味を持つので、番号から決まったキーを作れれば足りる。

import { assignSeats } from "../../../core/unit-state/seat-keys";
import type { UnitStateEntry, UnitStateStore } from "../../../core/unit-state/unit-state-store";

/** n 番目の席のキー（n の順に並ぶ） */
export function seat(n: number): string {
	return String(50_000_000 + n * 1024).padStart(8, "0");
}

/** 席のキーを n 個、並び順に作る */
export function seats(count: number): string[] {
	return assignSeats(new Array(count).fill(undefined));
}

/** 本文の行を1つ作る */
export function unitRow(overrides: Partial<UnitStateEntry> & { path: string }): UnitStateEntry {
	return {
		kind: "unit",
		seat: seat(0),
		level: 1,
		titleHash: "",
		hash: "",
		from: "",
		need: "",
		...overrides,
	};
}

/** 席のキーで本文の行を引く（無ければ undefined） */
export function unitEntryAt(store: UnitStateStore, filePath: string, seatKey: string): UnitStateEntry | undefined {
	return store.getEntriesByPath(filePath).find((e) => e.kind === "unit" && e.seat === seatKey);
}

/** 本文の hash で、席に着いていない行を引く（無ければ undefined） */
export function heldEntryWithHash(store: UnitStateStore, filePath: string, hash: string): UnitStateEntry | undefined {
	return store.getEntriesByPath(filePath).find((e) => e.kind === "held" && e.hash === hash);
}

/** 指定パスの**すべての**行の数（frontmatter の行も、席に着いていない行も含む） */
export function countAllRows(store: UnitStateStore, filePath: string): number {
	return store.getAllEntries().filter((e) => e.path === filePath).length;
}
