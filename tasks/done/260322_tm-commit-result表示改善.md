# チケット: tm-commit-result表示改善

## 1. 概要と方針

tm-commit結果プレビューの視認性を改善する。原文・訳文を改行分離してインデント2行表示にし、冗長な`[NEW]`/`[UPDATE]`タグを削除する。

## 2. 仕様

### Before
```
## New (3)
[NEW] "This is an introduction." → "これは導入文です。"
[NEW] "Click OK to proceed." → "OK をクリックして続行します。"
```

### After
```
## New (3)
"This is an introduction."
  → "これは導入文です。"

"Click OK to proceed."
  → "OK をクリックして続行します。"
```

- `[NEW]`/`[UPDATE]` タグを削除（セクション見出しで区別可能なため）
- 原文を1行目、訳文を`  → `付きインデントで2行目に表示
- 項目間に空行を挿入

## 3. シーケンス図

N/A（表示フォーマット変更のみ）

## 4. 設計

### 変更対象ファイル
- `src/commands/tm/tm-result-provider.ts` — `generateContent()` のフォーマット変更
- `src/test/commands/tm/tm-result-provider.test.ts` — テストのアサーション更新

### 変更内容
`generateContent()` 内のループで各 `TmResultItem` を以下の形式で出力：
```typescript
lines.push(`"${item.primary}"`);
lines.push(`  \u2192 "${item.local}"`);
lines.push("");
```

## 5. 考慮事項

- テストで `[NEW]`/`[UPDATE]` を検証しているアサーションをすべて新フォーマットに更新する必要がある
- 設計ドキュメント `docs/design/command_tm.md` にプレビュー形式の記載があれば更新する

## 6. 実装・テスト計画と進捗

- [x] `generateContent()` のフォーマット変更
- [x] テスト更新
- [ ] 設計ドキュメント更新（必要に応じて） → 不要（具体的フォーマット記載なし）

## 7. 品質要件チェック

- [x] 既存テストが新フォーマットで通過する
- [x] 0件表示（none）が正しく動作する
- [x] 特殊文字を含むケースが正しく出力される

## 8. まとめと改善提案

（作業完了後に記載）

## 9. 参考

- Wish: [tasks/wishlist.md](../wishlist.md) 「tm-commit 結果プレビューの表示改善」
