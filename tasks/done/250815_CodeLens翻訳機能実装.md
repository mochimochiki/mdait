# CodeLens翻訳機能実装

## 概要
エディタ上のmdaitマーカー行に表示されるCodeLensから翻訳を実行する機能を実装する。

## 背景
- 現在は`trans`コマンドでファイル全体または指定ユニットの翻訳を実行している
- エディタ上でマーカーを見ながら個別ユニットの翻訳を実行したいニーズがある
- 単体テスト実行ツールの再生ボタンのような直感的なUIを提供したい

## 要件

### 機能要件
1. mdaitマーカー行（`<!-- mdait aaaa1111 need:translate -->`など）にCodeLensを表示
2. `need:translate`フラグが付いたマーカーに「翻訳」ボタンを表示
3. ボタンクリックで該当ユニットの翻訳を実行
4. 翻訳完了後、エディタ上のコンテンツが更新される

### 非機能要件
- 既存の翻訳機能（`transUnitCommand`）を活用
- VS Code拡張機能の標準的なUXに準拠
- パフォーマンスに配慮（大きなファイルでも快適に動作）

## 設計方針

### アーキテクチャ
```
UI層: CodeLensProvider → Commands層: transUnitCommand → Core層: 翻訳処理
```

### フォルダ構成
```
src/ui/
├── codelens/
│   ├── codelens-provider.ts    # CodeLensProvider実装
│   └── codelens-command.ts           # CodeLensから呼び出されるコマンド
```

### 実装方針
1. **UI層**: `vscode.languages.registerCodeLensProvider`でマーカー検出とCodeLens表示
2. **Commands層**: 既存の`transUnitCommand(targetPath, unitHash)`を活用
3. **マーカー解析**: 既存のparser機能を活用してunitHashを抽出

## 実装タスク

### 1. CodeLensProvider実装
- [x] `MdaitCodeLensProvider`クラス作成
- [x] マーカー行の検出ロジック
- [x] `need:translate`フラグのチェック
- [x] CodeLens表示ロジック

### 2. コマンド統合
- [x] CodeLensから呼び出すコマンド作成
- [x] 既存の`transUnitCommand`との連携
- [x] エラーハンドリング

### 3. extension.tsへの登録
- [x] CodeLensProviderの登録
- [x] コマンドの登録

### 4. テスト
- [ ] CodeLensの表示テスト
- [ ] 翻訳実行テスト
- [ ] エラーケースのテスト

## 実装完了メモ

### 実装内容
- `src/ui/codelens/codelens-provider.ts`: CodeLensProviderの実装
- `src/ui/codelens/codelens-command.ts`: CodeLensコマンドの実装
- `src/extension.ts`: プロバイダーとコマンドの登録

### 設計との整合性
- ✅ 既存の`transUnitCommand`を活用して新しいメソッドは作成しない方針を採用
- ✅ マーカーからunitHashを抽出してコア機能を再利用
- ✅ UI層とCommands層の責務分離を実現
- ✅ VS Code標準のCodeLens APIを使用

### 技術的選択
- CodeLensProviderでマーカー検出とフィルタリングを実行
- 正規表現でmdaitマーカーと`need:translate`フラグを解析
- 既存のtransUnitCommandとの連携により、翻訳ロジックを再利用
- エラーハンドリングとユーザー通知を適切に実装

### 今後の改善点
- 大きなファイルでのパフォーマンス最適化
- マーカー解析ロジックの共通化（既存parserとの統合検討）
- E2Eテストの追加
- CodeLensの表示/非表示設定の追加

## 技術的考慮事項

### VS Code API
- `vscode.languages.registerCodeLensProvider`
- `vscode.CodeLens`, `vscode.Command`
- `vscode.Range`, `vscode.Position`

### 既存機能との連携
- `src/commands/trans/trans-command.ts`の`transUnitCommand`を活用
- `src/core/markdown/mdait-marker.ts`のマーカー解析機能を活用

### パフォーマンス
- 大きなファイルでの検索効率
- CodeLensの更新頻度の最適化

## 参考資料
- VS Code CodeLens API: https://code.visualstudio.com/api/language-extensions/programmatic-language-features#codelens-show-actionable-context-information
- 既存実装: `src/commands/trans/trans-command.ts`
