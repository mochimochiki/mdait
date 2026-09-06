// unit-state のテストで使う小道具。
//
// 席のキーは「二度と動かない背番号」なので、テストが 0, 1, 2… と書けなくなった。
// 並び順だけが意味を持つので、番号から決まったキーを作れれば足りる。

import { assignSeats } from "../../../core/unit-state/seat-keys";
import type { UnitStateEntry } from "../../../core/unit-state/unit-state-store";

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
