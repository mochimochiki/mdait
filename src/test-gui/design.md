# テスト構成

## 概要

このプロジェクトでは、テストを以下の3つのカテゴリに分けています：

## 1. 単体テスト (Unit Tests)
- **場所**: `src/test/core/`
- **実行**: `npm test` または `npm run test:unit`
- **特徴**: VS Codeに依存しない純粋なNode.jsテスト
- **CI対応**: ✅ CIの対応で、X ServerやGUI環境なしで実行可能

### 含まれるテスト
- ハッシュ計算とテキスト正規化 (`core/hash/`)
- Markdownユニットとマーカー (`core/markdown/mdait-unit.test.ts`, `core/markdown/mdait-marker.test.ts`)

## 2. VS Code統合テスト 
- **場所**: `src/test-gui/`
- **実行**: `npm run test:vscode` または `npm run test:gui`
- **特徴**: VS Code APIを使用するテスト
- **CI対応**: ❌ VS Codeのダウンロードとヘッドレス環境が必要

### 含まれるテスト
- 拡張機能のメインテスト (`extension/`)
- 設定関連 (`config/`)
- コマンド関連 (`commands/`)
- UIコンポーネント (`ui/`)
- Markdownパーサー（VS Code依存のため）(`core/markdown/parser.test.ts`)

## ディレクトリ構造

```
src/
├── test/           # 単体テスト（CIで実行）
│   └── core/       # VS Code非依存のコアテスト
│       ├── hash/
│       └── markdown/
└── test-gui/       # VS Code統合・GUIテスト（CIから除外）
    ├── commands/   # VS Codeコマンドテスト
    ├── config/     # VS Code設定テスト  
    ├── core/       # VS Code依存のコアテスト
    ├── extension/  # 拡張機能テスト
    └── ui/         # GUIコンポーネントテスト
```

## スクリプト

- `npm test` - 単体テストのみ実行（CI対応）
- `npm run test:unit` - 単体テストのみ実行
- `npm run test:vscode` - VS Code統合テストのみ実行
- `npm run test:gui` - VS Code統合テストのみ実行（test:vscodeと同じ）

## CI/CDでの使用

CI環境では `npm test` を実行してください。これにより、GUI環境を必要としない単体テストのみが実行されます。

```bash
# CI環境で実行するテスト
npm test

# 開発者がローカルで実行する全テスト
npm run test:unit    # 単体テスト
npm run test:vscode  # VS Code統合テスト
npm run test:gui     # GUIテスト
```

## 設定ファイル

- `.vscode-test.mjs` - VS Code統合テスト用設定（test-guiディレクトリを対象）
- `.vscode-test-gui.mjs` - VS Code統合テスト用設定（同上、後方互換性のため）
- `.mocharc.json` - 単体テスト用Mocha設定