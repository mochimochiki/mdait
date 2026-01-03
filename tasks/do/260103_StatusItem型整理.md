# 作業チケット: StatusItem型のDiscriminated Union化

## 1. 概要と方針

現在の`StatusItem`インターフェースは多数のオプショナルプロパティを持つ単一型であり、`type`プロパティによる分岐が必要。Discriminated Union（判別共用体）パターンを適用し、型安全性とIDE補完精度を向上させる。

**リファクタリング戦略:**
- `BaseStatusItem`に共通プロパティを定義
- `DirectoryStatusItem`/`FileStatusItem`/`UnitStatusItem`を個別に定義
- `StatusItem = DirectoryStatusItem | FileStatusItem | UnitStatusItem`として統合
- 既存コードの型ガードを自動的に効くように

## 2. 型設計

```typescript
// 共通プロパティ
interface BaseStatusItem {
  label: string;
  status: Status;
  isTranslating?: boolean;
  collapsibleState?: vscode.TreeItemCollapsibleState;
  iconPath?: vscode.ThemeIcon;
  tooltip?: string;
  contextValue?: string;
}

// ディレクトリ用
export interface DirectoryStatusItem extends BaseStatusItem {
  type: StatusItemType.Directory;
  directoryPath: string;
  children?: StatusItem[];
}

// ファイル用
export interface FileStatusItem extends BaseStatusItem {
  type: StatusItemType.File;
  filePath: string;
  fileName: string;
  translatedUnits: number;
  totalUnits: number;
  hasParseError?: boolean;
  errorMessage?: string;
  children?: UnitStatusItem[];
}

// ユニット用
export interface UnitStatusItem extends BaseStatusItem {
  type: StatusItemType.Unit;
  filePath: string;  // 親ファイルパス（必須化）
  unitHash: string;
  title?: string;
  headingLevel?: number;
  fromHash?: string;
  needFlag?: string;
  startLine?: number;
  endLine?: number;
}

// 統合型
export type StatusItem = DirectoryStatusItem | FileStatusItem | UnitStatusItem;
```

## 3. 考慮事項

- **後方互換性**: 既存コードで`item.type === StatusItemType.File`としている箇所は型ナローイングが効く
- 必須プロパティ化により、生成箇所での明示的な値指定が必要になる
- `StatusCollector`/`StatusItemTree`でのアイテム生成箇所を修正
- 型ガードヘルパー関数の追加（`isFileStatusItem(item): item is FileStatusItem`）

## 4. 実装計画と進捗

- [x] `src/core/status/status-item.ts`修正
  - `BaseStatusItem`インターフェース追加
  - `DirectoryStatusItem`/`FileStatusItem`/`UnitStatusItem`定義
  - `StatusItem`をUnion型に変更
  - 型ガードヘルパー関数追加
- [x] `src/core/status/status-collector.ts`修正
  - StatusItem生成箇所を新型に適合
- [x] `src/core/status/status-item-tree.ts`修正
  - 型アサーションの除去・型ガード使用
- [x] `src/ui/status/status-tree-provider.ts`修正
  - 型ナローイングの活用
- [x] `StatusTreeTermHandler`/`StatusTreeTranslationHandler`修正
  - 型チェックの簡素化
- [x] TypeScriptコンパイルエラー解消
- [x] 既存テストパス確認

## 5. テスト観点

- コンパイル時型チェックによるプロパティアクセスの安全性
- 既存のStatusItem生成・操作が正常動作
- ツリービュー表示が正常
- 型ガードヘルパーの動作確認
