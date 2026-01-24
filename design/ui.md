# UI層設計

## 役割

- VS Code上でmdaitの状態とアクションを可視化し、ユーザーにシームレスな操作体験を提供する。
- コマンドの呼び出しと進捗表示を担い、Core/Commands層からの通知を受け取りリアルタイムに反映する。

## 主要コンポーネント

- **StatusTreeProvider**: `StatusItemTree`をVS Code TreeViewに変換し、needフラグをアイコンとバッジで表現する。frontmatterを含む場合は先頭に表示し、ファイル翻訳の前にfrontmatter翻訳を実行可能にする。部分更新イベントに対応して最小限のDOM更新を行う。`Configuration.isConfigured()`がfalseの場合は空配列を返し、リソース消費を抑制する。
- **Welcome View**: `mdait.yaml`未設定時に表示される初期設定ガイド。`viewsWelcome`でギアアイコンCTAを表示し、`mdait.setup.createConfig`コマンドにリンク。`mdaitConfigured`コンテキスト変数で表示を制御。
- **Command Entry Points**: コマンドパレット、ツリービューのコンテキストメニュー、コード上のCodeLensからコマンド層を呼び出す。frontmatterはStatusTreeとCodeLensの両方から翻訳・ジャンプ・needクリア操作が可能。対象ファイルや言語を引数として構築する。
- **Progress Reporter**: sync/trans/term実行中の進行状況を表示し、`CancellationToken`でユーザーからの中断を処理する。
- **TranslationSummaryHoverProvider**: mdaitマーカー行およびfrontmatterマーカー行にホバーしたときに翻訳サマリ(処理時間・トークン数・用語候補・警告)を表示する。`SummaryManager`からハッシュをキーにサマリ情報を取得し、Markdown形式でリッチ表示。
- **SummaryDecorator**: 翻訳サマリの概要をマーカー行末尾にGitLens風のインライン表示で提供する。frontmatterマーカーも対象に含む。CodeLensと同じ色・フォントスタイルで統一し、詳細はHoverで確認可能。
- **SummaryManager**: 翻訳実行時に生成されたサマリデータ(`TranslationSummary`)をメモリ上でMap管理するシングルトン。永続化は不要で、VS Code再起動時にクリアされる。翻訳完了時に`trans-command`から呼び出され、Hover/Decorator表示時に参照される。

## 更新シーケンス

### ステータス更新フロー

```mermaid
sequenceDiagram
	participant User as User
	participant UI as StatusTreeProvider
	participant Cmd as Command層
	participant Core as StatusManager

	User->>UI: コマンド起動
	UI->>Cmd: 引数を渡して実行
	Cmd->>Core: ステータス更新要求
	Core-->>UI: changeイベント通知
	UI-->>User: ツリー/バッジ更新
```

- ドキュメント保存時は`workspace.onDidSaveTextDocument`で対象ファイルを検知し、`StatusManager.refreshFileStatus`を呼び出して手動編集とツリー表示を同期させる。

### 翻訳サマリ表示フロー

```mermaid
sequenceDiagram
	participant User
	participant TransCmd as TransCommand
	participant SummaryMgr as SummaryManager
	participant Decorator as SummaryDecorator
	participant Hover as HoverProvider

	User->>TransCmd: 翻訳実行
	TransCmd->>TransCmd: 翻訳処理・時間計測
	TransCmd->>SummaryMgr: saveSummary(unitHash, summary)
	TransCmd-->>Decorator: エディタ更新イベント
	Decorator->>Decorator: マーカー行にインライン表示
	User->>Hover: マーカー行にホバー
	Hover->>SummaryMgr: getSummary(unitHash)
	SummaryMgr-->>Hover: TranslationSummary
	Hover-->>User: 統計・用語候補・警告を表示
```

- 翻訳完了後、`SummaryManager`にサマリを保存し、`SummaryDecorator`がマーカー行末尾に簡潔な統計を表示。詳細情報は`HoverProvider`でオンデマンド提供。

## 視覚表現の原則

- needフラグ別に色とアイコンを固定し、どの画面でも同じ記号で意味が伝わるようにする。
- 進捗表示はファイル単位で「翻訳済み/要翻訳/エラー」の数値を表示し、折りたたみ表示でも情報が埋もれないよう簡潔にする。
- l10nシステム(`/l10n`配下)で文言を管理し、日本語/英語を等価に提供する。

## コンテキスト変数

- **mdaitConfigured**: `Configuration.isConfigured()`の結果に基づき、設定完了状態を示す。`true`の場合はツールバーボタン（sync/filter/glossary）を表示し、`false`の場合はWelcome Viewを表示。
- activation時と設定変更(`Configuration.onConfigurationChanged`)時に更新され、UI全体の表示状態を制御。
