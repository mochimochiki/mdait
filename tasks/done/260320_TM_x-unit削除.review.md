# レビューレポート: 260320_TM_x-unit削除

## サマリ

**全体評価:** ⭐⭐⭐⭐ (4/5)
**結論:** ⚠️ 条件付き承認
**指摘件数:** 🔴[重大: 0](#重大) 🟠[優先: 1件](#優先) 🟡[推奨: 0件] 🟢[任意: 1件](#任意)

**最重要論点:**
チケット仕様（x-unit / x-unit-hash の完全削除）の実装は正確。`canSkipUnit` 削除および `getEntriesByUnitPath` セマンティクス変更はいずれも `unitHash` / `unitPath` 削除の必然的帰結であり過剰スコープではない。ただし `getEntriesByUnitPath` のメソッド名が実態（全件返却）と乖離しており、呼び出し側が誤解するリスクがある。**設計書は本レビューで更新済み。**

**変更:**
- [src/core/tm/types.ts](../../src/core/tm/types.ts): `TmVariant` から `unitPath?` / `unitHash?` 削除
- [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts): 定数・パースロジック削除、`getEntriesByUnitPath` セマンティクス変更
- [src/commands/tm/commit-processor.ts](../../src/commands/tm/commit-processor.ts): `canSkipUnit` 削除・`TmCommitResolvedUnit` はそのまま
- [src/commands/trans/trans-command.ts](../../src/commands/trans/trans-command.ts): `firstUsedIn: ""` 2箇所修正
- [src/test/core/tm/tmx-store.test.ts](../../src/test/core/tm/tmx-store.test.ts): テストフィクスチャ更新・新セマンティクステスト追加
- [src/test/commands/tm/commit-processor.test.ts](../../src/test/commands/tm/commit-processor.test.ts): canSkipUnit 関連テスト削除

---

## 🟠優先 (1件)

### `getEntriesByUnitPath` のメソッド名と実装の乖離

**場所:**
- [ ] [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L428)（`getEntriesByUnitPath` 定義、L428付近）

**問題:**
`_unitPath` と `_localLang` の2パラメータにアンダースコアが付いており、実装では完全に無視される。メソッドは「primaryLang を持つ全エントリを返す」動作になっているが、名前は「unitPath による絞り込み」を示唆する。

呼び出し元 [src/commands/tm/commit-processor.ts](../../src/commands/tm/commit-processor.ts#L102) は `primaryUnit.unitPath` を渡して「そのユニットに属するエントリだけが返る」と読める。スキップ最適化が消えた今、TMX が大規模になるほど `filterRelevantEntries` に渡るエントリが増加し、性能劣化の起点になりうる。

**提案:**
今回チケットのスコープ外として受け入れ可だが、早期に追加チケットを起票して以下を対応すること:
- メソッド名を `getEntriesForCommit(primaryLang)` など実態を表す名前にリネーム
- 不要になった2パラメータ（`unitPath`, `localLang`）をシグネチャから除去
- 呼び出し元の引数も整理

---

## 🟢任意 (1件)

### `TmMatch.firstUsedIn` フィールドの実用性

**場所:**
- [ ] [src/core/tm/types.ts](../../src/core/tm/types.ts#L55)（`firstUsedIn: string`）
- [ ] [src/core/tm/tmx-store.ts](../../src/core/tm/tmx-store.ts#L382)（`firstUsedIn: ""`）
- [ ] [src/commands/trans/trans-command.ts](../../src/commands/trans/trans-command.ts#L986)（`firstUsedIn: ""`）

**問題:**
`TmVariant.unitPath` 削除により `firstUsedIn` は常に `""` になった。`formatTmReferences()` はこのフィールドを出力に使っていないため機能影響はゼロ。しかし型上は意味のある値を期待するフィールドとして残っており、将来の実装者が混乱する可能性がある。

**提案:**
将来的に `TmMatch` から `firstUsedIn` を削除するか、常に空であれば型を `""` リテラル型に変更することを検討。今回スコープ外で可。

---

## 📊 全体整合性

### 特別注意事項の評価

ユーザーから指摘された3点について:

| 変更 | チケット仕様との照合 | 評価 |
|------|---------------------|------|
| `canSkipUnit` 完全削除 | `TmVariant.unitHash` 削除の必然的帰結。unitHash なしでハッシュ比較は不可能 | ✅ 適切 |
| `getEntriesByUnitPath` セマンティクス変更 | `TmVariant.unitPath` 削除により unitPath フィルタリングが不可能になった必然的帰結 | ✅ 適切（命名問題は別途対応） |
| `getExistingTmEntries` 廃止メソッド削除 | `@deprecated` だったため削除は適切 | ✅ 適切 |

**性能への影響（canSkipUnit 削除）:**
tm-commit は開発者が明示的に実行するバッチ処理であり、同一ユニットを短時間内に再実行するケースは少ない。`canSkipUnit` のスキップ効果は「変更なしユニットの LLM 呼び出し省略」だったが、`filterRelevantEntries` により変更のないユニットは既存 TM と primary テキストが一致するため `requiredUpdateTuids` が空になり、LLM が `[]` を返して実質的な作業は最小となる。完全なスキップではないが実害は限定的。

### ワークスペース全体の整合性

**Core**: `TmVariant` が `{ text: string }` のみに簡素化。`TmEntry` / `TmxStore` の責務は明確で問題なし。
**Commands**: `TmCommitResolvedUnit` に `unitPath` / `unitHash` が残っているが、これはロギング用途（処理トレース）であり TM ロジックとは非依存。適切な分離。
**テスト**: `getEntriesByUnitPath` の新セマンティクステスト追加済み ✓ x-unit/x-unit-hash が出力されないことを検証済み ✓ 基本フロー（新規登録・更新・guard・retry）のカバレッジは十分。
**設計書**: `docs/design/core.md`・`docs/design/command_tm.md` を本レビューで更新済み。更新内容: `TmVariant` 型定義の `unitPath?`/`unitHash?` 削除、`canSkipUnit()` ステップ削除、シーケンス図更新、必須更新判定条件から `unitHash` 削除、「検討した代替案」の dual-hash スキップを廃止として更新。

### 後方互換性

リリース前のため既存 TMX ファイルとの互換性維持は不要。旧 TMX に `x-unit` / `x-unit-hash` prop が含まれていてもパース時にサイレント無視されるため安全。

### セキュリティ

TMX I/O に変更があるが、`fast-xml-parser` による標準的なパース処理であり問題なし。

---

## 総評

チケット仕様（x-unit / x-unit-hash の完全削除）は正確に実装されており、ビルドエラーなし・テスト全通過が確認されている。設計外変更として指摘された3点はすべてチケット仕様の必然的帰結であり、過剰スコープではないと判断する。

メソッド名 `getEntriesByUnitPath` の問題は保守性上の懸念だが、今回の変更の正確性を損なうものではなく、別チケットでのリファクタリングが適切。設計書は本レビュー内で更新済み。
