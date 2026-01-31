# 作業チケット: StatusパネルのcollapsibleState管理リファクタリング

## 1. 概要と方針

ツリー展開時にサークルが表示されたまま開かない問題を解消するため、`collapsibleState`の管理をCore層からUI層（`StatusTreeProvider.getTreeItem`）へ移行する。VSCodeの標準的なTreeView管理に従い、`getTreeItem`で子要素の有無に基づいて動的に`collapsibleState`を決定することで、VSCodeの自動開閉管理との競合を排除する。

## 2. シーケンス図

```mermaid
sequenceDiagram
    participant User as ユーザー
    participant VSCode as VSCode TreeView
    participant Provider as StatusTreeProvider
    participant Tree as StatusItemTree
    participant Collector as StatusCollector

    rect rgb(230, 230, 250)
        Note over User, Provider: 現状（Before）
        VSCode->>Provider: getTreeItem(element)
        Provider->>Provider: element.collapsibleState使用
        Note right of Provider: Core層のcollapsibleStateを<br/>そのまま返却（問題の原因）
    end

    rect rgb(230, 250, 230)
        Note over User, Provider: 改善後（After）
        VSCode->>Provider: getTreeItem(element)
        Provider->>Provider: 子要素有無を判定
        Note right of Provider: File: children存在確認<br/>Directory: getDirectoryChildren<br/>Unit/Frontmatter: None
        Provider-->>VSCode: 動的にCollapsibleState決定
    end
```

## 3. 考慮事項

### 3.1 互換性の維持
- 現在のUI/UXは完全に維持する
- ファイル・ディレクトリ・ユニットの表示順序や階層構造は変更しない
- アイコン・ラベル・コンテキストメニューの動作は維持

### 3.2 責務の移行とcollapsibleStateの削除
- UI層への完全移行後、`collapsibleState`プロパティは不要となる
- 以下の箇所から`collapsibleState`を削除する：
  - `BaseStatusItem`インターフェース（`status-item.ts`）
  - `StatusCollector`での設定処理（`status-collector.ts`）
  - `StatusItemTree`での設定処理（`status-item-tree.ts`）

### 3.3 テスト戦略
- 既存のGUIテストが通過することを確認
- 手動テストで展開・折りたたみ動作を検証

### 3.4 リスク
- VSCodeのTreeView APIの挙動に依存するため、API変更時の影響を受ける可能性

## 4. 実装計画と進捗

### Phase 1: UI層での動的判定に移行

- [x] **4.1** `StatusTreeProvider.getTreeItem`を修正（`src/ui/status/status-tree-provider.ts`）
  - `determineCollapsibleState(element: StatusItem)`メソッドを新規追加
  - 判定ロジック:
    - `StatusItemType.Directory`: `this.statusItemTree.getDirectoryChildren(element.directoryPath).length > 0`なら`Collapsed`、なければ`None`
    - `StatusItemType.File`: `this.getFileChildren(element).length > 0`なら`Collapsed`、なければ`None`
    - `StatusItemType.Unit`: 常に`None`
    - `StatusItemType.Frontmatter`: 常に`None`
  - `getTreeItem`の`new vscode.TreeItem(element.label, element.collapsibleState)`を`new vscode.TreeItem(element.label, this.determineCollapsibleState(element))`に変更

### Phase 2: Core層からcollapsibleStateを削除

- [x] **4.2** `BaseStatusItem`から`collapsibleState`プロパティを削除（`src/core/status/status-item.ts`）
  - `BaseStatusItem`インターフェースの`collapsibleState?: vscode.TreeItemCollapsibleState;`を削除

- [x] **4.3** `StatusCollector`から`collapsibleState`設定を削除（`src/core/status/status-collector.ts`）
  - `buildFileStatusItem`メソッド: `collapsibleState`プロパティ削除
  - `buildEmptyFileStatusItem`メソッド: `collapsibleState`プロパティ削除
  - `buildErrorFileStatusItem`メソッド: `collapsibleState`プロパティ削除
  - `collectAllFromDirectory`メソッドのエラー処理ブロック: `collapsibleState`プロパティ削除

- [x] **4.4** `StatusItemTree`から`collapsibleState`設定を削除（`src/core/status/status-item-tree.ts`）
  - `recalcDirectoryAggregate`メソッド: `collapsibleState`設定ブロック削除（hasFiles/hasSubDirsの判定部分）
  - `createDirectoryStatusItem`メソッド: `collapsibleState`プロパティ削除（末尾の即時実行関数部分）

### Phase 3: 検証

- [x] **4.5** 既存テスト（`npm test`）が通過することを確認
- [x] **4.6** 手動テスト: 空ディレクトリ、単一ファイル、frontmatterのみのファイル等のエッジケースで展開・折りたたみ動作を検証
- [x] **4.7** コードレビューおよびCodeQL検査を実施

## 5. 品質要件チェック
- [x] 全テスト通過（111件）
- [x] TypeScriptコンパイルエラーなし
- [x] Lintエラーなし
- [x] コードレビュー承認済み

## 6. まとめと改善提案
`collapsibleState`管理をCore層からUI層へ移行し、VSCode TreeViewの標準的な管理に準拠させた。これにより、ツリー展開時のサークル表示問題が解消された。

**今後の改善点:**
- VSCode TreeView APIの仕様変更に備え、UIテストの自動化を検討
