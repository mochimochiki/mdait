# コードスタイルと規約

## フォーマット規則（Biome設定）
- **インデントスタイル**: タブ
- **行幅**: 120文字
- **クォートスタイル**: ダブルクォート
- **Organize Imports**: 有効

## TypeScript設定
- **モジュールシステム**: Node16
- **Strict Mode**: 有効
- **noImplicitReturns**: true
- **noFallthroughCasesInSwitch**: true

## Import規約
- **Node.js buildinモジュール**: `node:`プレフィックスを使用
  - 例: `import * as fs from 'node:fs'`

## テスト規約
- **フレームワーク**: Mocha TDDスタイル
- **スタイル**: `suite`と`test`を使用（`describe`/`it`は使用しない）
- **テスト名**: 日本語で記述
- **配置**: 
  - 単体テスト: `src/test/`（`src`のディレクトリ構造に対応）
  - GUIテスト: `src/test-gui/`
- **Mochaのimport**: 明示的import不要

## 実装時の注意事項
- 既存のコード構造を確認して、周りのコードにスタイルを合わせる
- `design/`や`tasks/do/<作業名>.md`を参照して設計に従って実装
- 指示されていない機能や要件について勝手に実装しない
- `package.json`に記載の既存パッケージで実装（新パッケージは承認必要）
