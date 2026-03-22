# チケット: TM x-unit / x-unit-hash フィールド削除

## 1. 概要と方針

TMX の `<prop type="x-unit">` (ファイルパス) と `<prop type="x-unit-hash">` (ユニットハッシュ) は、現在どこからも利用されておらず、正確に更新し続けるコストもある割に有用な使い道がない。リリース前のため互換性維持は不要。コードベースから痕跡を全て削除する。

## 2. 仕様

- `TmVariant.unitPath` フィールドを削除
- `TmVariant.unitHash` フィールドを削除
- TMX パース時の `x-unit` / `x-unit-hash` prop 読み込みを削除
- TMX シリアライズ時の `x-unit` / `x-unit-hash` prop 書き込みを削除
- `PROP_TYPE_UNIT` / `PROP_TYPE_UNIT_HASH` 定数を削除
- 関連テストを更新

## 3. シーケンス図

変更なし（TMX I/O の内部削除のみ）。

## 4. 設計

### 影響ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/core/tm/types.ts` | `TmVariant` から `unitPath?` / `unitHash?` を削除 |
| `src/core/tm/tmx-store.ts` | `PROP_TYPE_UNIT` / `PROP_TYPE_UNIT_HASH` 定数削除、`parseTuNode` の読み込みロジック削除、`buildTuObject` の書き込みロジック削除 |
| `src/test/core/tm/tmx-store.test.ts` | テストの TMX フィクスチャから `x-unit` / `x-unit-hash` prop を削除、unitPath/unitHash の参照を削除 |

## 5. 考慮事項

- リリース前のため既存 TMX ファイルとの後方互換は不要
- `parseTuNode` の `legacyUnitPath` 変数も削除される（x-unit を TU レベルの prop から読む仕組みも不要になる）
- `current-primary-unit-collector.ts` や cleanup 系コードは `unitPath` / `unitHash` を参照していない（確認要）

## 6. 実装・テスト計画と進捗

- [x] `TmVariant` から `unitPath?` / `unitHash?` 削除
- [x] `tmx-store.ts` の定数・パース・ビルドロジック削除
- [x] テストフィクスチャ・アサーション更新
- [x] ビルド確認（`npx tsc --noEmit`）
- [x] 全テスト通過確認

## 7. 品質要件チェック

- [x] TMX ファイルへの x-unit / x-unit-hash 書き込みが完全になくなること
- [x] TMX ファイルの読み込み時にエラーがないこと（古い形式は harmlessly 無視される）
- [x] ビルドエラーなし
- [x] 全テスト通過

## 8. まとめと改善提案

（作業完了後に記入）
