# 推奨コマンド

## ビルド＆コンパイル
```powershell
npm run compile      # TypeScriptコンパイル（単発）
npm run watch        # ウォッチモード（継続的コンパイル）
```

## Lint＆フォーマット
```powershell
npm run lint         # Biomeによるリント実行
```

## テスト実行
```powershell
npm test                   # 単体テスト実行（test:unitのエイリアス）
npm run test:unit          # 単体テスト（Core層のみ）
npm run test:vscode        # GUI/統合テスト（VS Code Test RunnerによるE2Eテスト）
npm run copy-test-files    # テスト前の初期状態準備（sample-content → workspace/content）
```

## 国際化（i18n）
```powershell
npm run l10n                # ローカライゼーションファイルのエクスポート
npm run l10n-validate       # ローカライゼーションファイルの検証
```

## タスク実行
VS Code内で以下のタスクが利用可能：
- **copy-test-content**: テストコンテンツの同期
- **npm-watch**: ウォッチモードでのビルド（バックグラウンド）
- **build-and-copy** (デフォルトビルドタスク): copy-test-content → npm-watch の順次実行

## Windowsシステムコマンド
```powershell
Get-ChildItem <path>        # ディレクトリ一覧表示（ls相当）
Set-Location <path>         # ディレクトリ移動（cd相当）
Select-String <pattern>     # テキスト検索（grep相当）
Get-Content <file>          # ファイル内容表示（cat相当）
Remove-Item <path>          # ファイル/ディレクトリ削除（rm相当）
```

## Git操作
```powershell
git status                  # 変更状態確認
git add <file>              # ステージング
git commit -m "message"     # コミット
git push                    # リモートへプッシュ
git diff                    # 差分表示
```
