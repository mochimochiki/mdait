# コマンド層設計

このドキュメントでは、`mdait`拡張機能のコマンド層に関する設計を詳述します。各コマンドの目的、動作フロー、及び重要な考慮事項を説明します。

---

## setup（初期設定）

### setup.createConfig（設定ファイル作成）

- 拡張機能にバンドルされた`mdait.template.json`をワークスペースルートに`mdait.json`としてコピー
- テンプレートファイルは拡張機能のルートに配置され、`ExtensionContext.extensionPath`を通じてアクセス
- ファイル作成後、VS Codeエディタで開いてユーザーに編集を促す
- JSON Schemaによる補完と検証が自動的に機能
- 保存時に`Configuration`が自動リロードし、`mdaitConfigured`コンテキスト変数を更新
- 既に`mdait.json`が存在する場合は警告メッセージを表示して上書きを防止
- テンプレートファイルが見つからない場合はエラーメッセージを表示（拡張機能の再インストールを促す）

**主要コンポーネント:**
- [src/commands/setup/setup-command.ts](../src/commands/setup/setup-command.ts): `createConfigCommand()` - テンプレートファイルのコピーとエディタで開く処理を実行

**シーケンス:**

```mermaid
sequenceDiagram
	participant User
	participant Cmd as SetupCommand
	participant FS as File System
	participant Cfg as Configuration
	participant UI as VS Code

	User->>Cmd: mdait.setup.createConfig
	Cmd->>FS: mdait.jsonの存在チェック
	alt 既存ファイルあり
		Cmd-->>User: 警告メッセージ表示
	else ファイルなし
		Cmd->>FS: 拡張機能バンドルのmdait.template.jsonを読み込み
		Cmd->>FS: ワークスペースルートにmdait.jsonを作成
		Cmd->>UI: mdait.jsonをエディタで開く(JSON Schema有効)
		User->>FS: 設定を編集して保存
		FS->>Cfg: ファイル変更イベント
		Cfg->>Cfg: リロード＆バリデーション
		Cfg->>UI: mdaitConfiguredコンテキスト更新
		UI-->>User: Welcome View非表示、ツリー表示
	end
```


---

## sync（ユニット同期）

- Markdown間のユニット対応付けを確立し、`hash`・`from`・`need`を再計算。
- 差分検出後は`need:translate`付与や未使用ターゲットユニットの削除/保留を制御。
- [core.md](core.md)のSectionMatcherとStatus管理を活用し、冪等な再実行を保証。
- 同期完了後はソース/ターゲット両ファイルのステータスを`StatusManager.refreshFileStatus`で再計算し、ツリー表示を即時追従させる。

**主要コンポーネント:**
- [src/commands/sync/sync-command.ts](../src/commands/sync/sync-command.ts): `syncCommand()`, `syncMarkdownFile()` - ファイル対応付けと差分適用
- [src/commands/sync/section-matcher.ts](../src/commands/sync/section-matcher.ts): `SectionMatcher.matchSections()` - ユニット間の対応関係を検出

**シーケンス:**

```mermaid
sequenceDiagram
	participant UX as UI/Command
	participant Cmd as SyncCommand
	participant Core as SectionMatcher
	participant Status as StatusManager

	UX->>Cmd: 対象ファイル選択
	Cmd->>Core: ユニット対応付け要求
	Core-->>Cmd: 差分結果
	Cmd->>Cmd: need/hash 更新・新規ユニット生成
	Cmd->>Status: ステータス再計算
	Status-->>UX: ツリー更新
```

---

## trans (翻訳)

- `need:translate`ユニットを絞り込み、設定されたプロバイダーで一括翻訳。
- 翻訳完了後はユニット本文と`hash`を更新し、`need`フラグを除去。
- キャンセルやリトライに備え、進捗をUIへ逐次通知する。
- **用語集連携**: `terms.csv`が存在する場合、翻訳対象ユニットに出現する用語を抽出してAIプロンプトに含め、用語統一を図る(キャッシュはmtime比較で管理)。
- **前回訳文参照**: 原文改訂時（`from`フィールドで旧ソースハッシュを追跡可能）、前回の訳文を翻訳プロンプトに含めて参照させる。変更不要な箇所は既訳を尊重し、変更が必要な箇所のみを変更。
- **翻訳品質チェック**: 翻訳後に原文と訳文を比較し、確認推奨箇所（数値の不一致、構造の差異など）を検出。問題がある場合は`need:review`ステータスを設定し、Hoverツールチップに理由を表示。
- **並列実行制御**:
  - ディレクトリ翻訳: ファイルを順次処理(キャンセル即応性とレート制限対策を重視)
  - ファイル翻訳: ユニットを順次処理(AI APIレート制限対策)
  - 現状は順次実行を採用し、キャンセル操作への即応性とAI APIのレート制限回避を優先
  - 将来的な拡張: 設定可能な並列数制限(セマフォ方式)の導入を検討(例: `mdait.trans.concurrency`で同時翻訳数を指定)
- **キャンセル管理**: VSCode標準の`withProgress`パターンで実装。通知バーの×ボタンから即座にキャンセル可能。進捗表示はファイル翻訳="X/Y units"、ディレクトリ翻訳="X/Y files"形式。

**主要コンポーネント:**
- [src/commands/trans/trans-command.ts](../src/commands/trans/trans-command.ts): `transCommand()`, `transUnitCommand()` - 翻訳対象の選択と翻訳実行
- [src/commands/trans/term-extractor.ts](../src/commands/trans/term-extractor.ts): `TranslationTermExtractor.extract()` - 用語集から該当用語を抽出

**シーケンス:**

```mermaid
sequenceDiagram
	participant UX as UI/Command
	participant Cmd as TransCommand
	participant Status as StatusManager
	participant Builder as AIServiceBuilder
	participant AI as AIService

	UX->>Cmd: 翻訳対象を実行
	Cmd->>Status: need:translateユニット収集
	Cmd->>Builder: プロバイダー構築
	Builder-->>Cmd: AIService
	loop 各ユニット
		Cmd->>AI: ユニット本文と設定送信
		AI-->>Cmd: 翻訳結果
		Cmd->>Status: ユニット内容とneed更新
	end
	Status-->>UX: 進捗/完了通知
```

---

## term（用語集）

- `mdait.term.detect`: 原文ユニットをバッチ化し、AIで用語候補を抽出。既存用語集とマージして保存。
  - `mdait.term.detect.directory`: ソースディレクトリ配下の全ファイルを対象に用語検出
  - `mdait.term.detect.file`: 単一ソースファイルを対象に用語検出
- `mdait.term.expand`: 既存の翻訳から用語訳を抽出し`terms.csv`へ反映。原文/訳文ペアから用語訳を推定して展開。
  - `mdait.term.expand.directory`: ターゲットディレクトリ配下のファイルに対応するソースのみを対象に展開
  - `mdait.term.expand.file`: 単一ターゲットファイルに対応するソースのみを対象に展開
- **並列実行制御**: ディレクトリ処理時はファイルを順次処理（trans翻訳と同様の理由）。バッチサイズはAI APIの入力トークン制限に応じて調整。

**主要コンポーネント:**
- [src/commands/term/command-detect.ts](../src/commands/term/command-detect.ts): `detectTermCommand()` - 用語検出のエントリーポイント
- [src/commands/term/term-detector.ts](../src/commands/term/term-detector.ts): `TermDetector.detect()` - AI APIを使用した用語抽出処理
- [src/commands/term/command-expand.ts](../src/commands/term/command-expand.ts): `expandTermCommand()` - 用語展開のエントリーポイント
- [src/commands/term/term-expander.ts](../src/commands/term/term-expander.ts): `TermExpander.expand()` - 原文/訳文ペアから用語訳を推定
- [src/commands/term/status-tree-term-handler.ts](../src/commands/term/status-tree-term-handler.ts): ステータスツリーからの用語検出/展開アクションハンドラ

**term.detectシーケンス:**

```mermaid
sequenceDiagram
	participant UX as UI/Command
	participant Cmd as TermDetectCommand
	participant Repo as TermsRepository
	participant AI as AIService

	UX->>Cmd: 対象ファイル指定
	Cmd->>Repo: 既存terms.csv読み込み
	Cmd->>Cmd: ユニットバッチ生成
	loop 各バッチ
		Cmd->>AI: 原文ユニットと既存用語送信
		AI-->>Cmd: 新規用語候補
		Cmd->>Cmd: 重複除外・統合
	end
	Cmd->>Repo: 用語集マージ・保存
	Repo-->>UX: 更新結果通知
```

**term.expandシーケンス:**

```mermaid
sequenceDiagram
	participant UX as UI/Command
	participant Cmd as TermExpandCommand
	participant Repo as TermsRepository
	participant Expander as TermExpander

	UX->>Cmd: 対象言語指定
	Cmd->>Repo: 未展開用語取得
	Cmd->>Cmd: Unitペア抽出・バッチ化
	loop 各バッチ
		Cmd->>Expander: 原文+訳文と用語リスト送信
		Expander-->>Cmd: 用語訳ペア
	end
	Cmd->>Repo: CSV更新
	Repo-->>UX: 保存完了通知
```

---

## translate-selection（オンデマンド翻訳）

- エディタ選択範囲を一時的に翻訳する軽量機能（mdaitステータスに影響しない）。詳細は [design/command_trans_ondemand.md](design/command_trans_ondemand.md) を参照。
---

## 考慮事項

- すべてのコマンドはVSCode標準の`withProgress`パターンで`CancellationToken`対応と冪等性確保を優先する。
- 設定は[config.md](config.md)で定義されたシングルトン経由で最新値を取得する。
- 翻訳や用語抽出など外部呼び出しは[api.md](api.md)のビルダーで動的にプロバイダー切り替えを行う。

## 参照

- 実装コード: `src/commands/` 以下
- UI連携: [ui.md](ui.md)
- テスト観点: [test.md](test.md)