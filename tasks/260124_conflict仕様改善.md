# 作業チケット: conflict時の仕様改善

## 1. 概要と方針

ソースとターゲットの両方が変更された場合に発生する`need:solve-conflict`状態について、ユーザーの解決手順を明確化し、conflict解消前の再sync時にも冪等性を保つ設計を策定する。現状はconflict時にハッシュを更新しないため、再sync時に隣接ユニットへ影響が伝搬するリスクがある。

## 2. 現状分析

### 2.1 現在のconflict判定ロジック（marker-sync.ts）

```typescript
const isSourceChanged = existingMarker.from !== sourceHash;
const isTargetChanged = targetHash !== null && existingMarker.hash !== targetHash;

if (isSourceChanged && isTargetChanged) {
    existingMarker.setNeed("solve-conflict");
    // ハッシュは更新しない（競合状態を保持）
    return { marker: existingMarker, changed: true, changeType: "conflict" };
}
```

**問題点**: ハッシュを更新しないため、再syncで「古いハッシュ」と「新しいコンテンツ」の不整合が検出され、意図しないconflict伝搬が発生する。

### 2.2 現在の解決手段

- CodeLensの「競合解決済み」ボタンで`need`タグのみ削除
- ハッシュ・fromは手動修正が必要だが、ユーザーにその認識がない

## 3. 操作シナリオと設計的洞察

### シナリオ1: 正常なconflict発生と解決

**前提**: ソース側でユニットAを編集し、ターゲット側でもユニットAを編集後、sync実行

**現状動作**:
1. 両方に`need:solve-conflict`付与
2. ハッシュ・fromは古い値のまま

**問題**: ユーザーが片方の内容を採用して手動編集しても、ハッシュが古いままなので次回syncで再度conflictになる可能性がある

**望ましい動作**:
- conflict解決操作で「どちら側の内容を正とするか」を明示的に選択させ、ハッシュを正しく更新する

### シナリオ2: conflict解消前に再度sync

**前提**: conflict状態のまま再度syncを実行

**現状動作**:
1. 古いハッシュとの比較で差分が検出される
2. 隣接ユニットに影響が伝搬（冪等性の破綻）

**望ましい動作**:
- `need:solve-conflict`が付いているユニットはsync処理をスキップし、状態を維持（冪等性確保）
- ユーザーに「未解決のconflictがあります」と警告

### シナリオ3: conflict状態のまま翻訳（trans）実行

**前提**: conflict状態のユニットに対してtransを実行

**現状動作**: transはneed:translateまたはneed:revise@のユニットを対象とするため、conflict状態は翻訳されない

**望ましい動作**: 現状で適切。conflict解決を優先させる設計は正しい

### シナリオ4: 片方のマーカーを手動削除

**前提**: ユーザーがソースまたはターゲットのmdaitマーカーを手動で削除

**現状動作**: マーカーなしユニットは新規ユニットとして扱われ、マッチングが崩れる

**望ましい動作**:
- 異常操作としてユーザーに警告を出す
- または、マーカー削除を「リセット」として扱い、新規ユニットとして再同期

### シナリオ5: conflict解決時に「ソース側採用」「ターゲット側採用」「手動マージ」

**前提**: ユーザーがconflictを解決しようとする

**現状動作**: CodeLensで`need`をクリアするのみ。どちらを採用したかの概念がない

**望ましい動作**:
- **ソース側採用**: ターゲットをソースの内容で上書きし、`from`と`hash`を更新、`need:translate`付与
- **ターゲット側採用**: ターゲットの現在内容を正とし、`hash`を更新、`from`を現在のソースハッシュに更新、`need`クリア
- **手動マージ**: ユーザーが編集完了後に「解決完了」をクリック、`hash`を再計算して更新

## 4. 設計方針

### 4.1 conflict状態のsync処理スキップ

conflict状態（`need:solve-conflict`）のユニットはsync処理でハッシュ比較・更新をスキップし、冪等性を確保する。

```typescript
// marker-sync.ts への追加
if (existingMarker?.need === "solve-conflict") {
    // conflict状態のユニットはスキップ（状態維持）
    return { marker: existingMarker, changed: false, changeType: "none" };
}
```

### 4.2 conflict解決オプションの提供

CodeLensまたはQuickPickで以下の選択肢を提供:

1. **ソース側を採用して翻訳**: ターゲット内容をソースで上書き、`need:translate`
2. **ターゲット側を採用**: ハッシュを再計算して正常状態に戻す
3. **手動でマージ済み**: 現在のターゲット内容を正としてハッシュ更新

### 4.3 ソース側マーカーの扱い

現状、conflict時はソース側にも`need:solve-conflict`が付与されるが、実質的にはターゲット側の問題。ソース側のneedフラグの必要性を再検討する。

**方針**: ソース側には`need:solve-conflict`を付与しない（ソースは常に正。conflictはターゲット側の問題）

### 4.4 UI表示の改善

- conflict状態のユニットにはより目立つ警告アイコンを表示
- ステータスツリーでconflictユニット数を集計表示
- Hoverで「解決方法」のヒントを表示

## 5. 考慮事項

- **後方互換性**: 既存のconflict状態のファイルに対する移行処理が必要か検討
- **frontmatter conflict**: 本文ユニットと同様のconflict処理をfrontmatterにも適用
- **複数ファイル一括解決**: 大量のconflictがある場合の一括解決UIの検討（スコープ外だが将来課題）
- **Undo対応**: conflict解決操作のUndo可能性（VS Codeの編集として実装すれば対応可能）

## 6. 実装計画（概要）

- [ ] シナリオ2対応: conflict状態のユニットをsync処理でスキップ
- [ ] シナリオ5対応: conflict解決オプションの実装（CodeLens拡張）
- [ ] ソース側needフラグの仕様変更
- [ ] UI改善: conflict警告とヒント表示
- [ ] 単体テスト・GUIテストの追加
