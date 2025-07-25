# GUIテスト分離

## 概要

GUIテストは通常のテストから分離され、VS CodeのGUIコンポーネントが利用できないCI環境での実行を回避しています。

## ディレクトリ構造

```
src/
├── test/          # 通常のユニットテスト（CIで実行）
│   ├── commands/
│   ├── core/
│   ├── config/
│   └── ...
└── test-gui/      # GUIテスト（CIから除外）
    └── ui/        # VS Code UIコンポーネントテスト
        └── status/
```

## スクリプト

- `npm test` - 通常のテストを実行（GUIテストを除外）
- `npm run test:gui` - GUIテストのみを実行

## CI設定

CIパイプラインは`npm test`を実行し、GUIテストを除外することで、VS Code UIコンポーネントが必要なテストがCIビルドを破綻させることを防いでいます。

## 設定ファイル

- `.vscode-test.mjs` - 通常のテスト用設定
- `.vscode-test-gui.mjs` - GUIテスト用設定