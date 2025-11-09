# コマンド層設計

## 役割

- ユーザー起点の操作をmdaitのワークフローに変換し、Core層の機能を組み合わせて実行する。
- 設定値やUIの入力に応じて必要なデータを収集し、処理結果をステータス更新やファイル書き込みとして反映する。

## コマンド別要点

### sync（ユニット同期）

- Markdown間のユニット対応付けを確立し、`hash`・`from`・`need`を再計算。
- 差分検出後は`need:translate`付与や未使用ターゲットユニットの削除/保留を制御。
- [core.md](core.md)のSectionMatcherとStatus管理を活用し、冪等な再実行を保証。
- 同期完了後はソース/ターゲット両ファイルのステータスを`StatusManager.refreshFileStatus`で再計算し、ツリー表示を即時追従させる。

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

### trans(AI翻訳)

- `need:translate`ユニットを絞り込み、設定されたプロバイダーで一括翻訳。
- 翻訳完了後はユニット本文と`hash`を更新し、`need`フラグを除去。
- キャンセルやリトライに備え、進捗をUIへ逐次通知する。
- **用語集連携**: `terms.csv`が存在する場合、翻訳対象ユニットに出現する用語を抽出してAIプロンプトに含め、用語統一を図る(キャッシュはmtime比較で管理)。
- **並列実行制御**:
  - ディレクトリ翻訳: ファイルを順次処理(キャンセル即応性とレート制限対策を重視)
  - ファイル翻訳: ユニットを順次処理(AI APIレート制限対策)
  - 現状は順次実行を採用し、キャンセル操作への即応性とAI APIのレート制限回避を優先
  - 将来的な拡張: 設定可能な並列数制限(セマフォ方式)の導入を検討(例: `mdait.trans.concurrency`で同時翻訳数を指定)
- **キャンセル管理**: VSCode標準の`withProgress`パターンで実装。通知バーの×ボタンから即座にキャンセル可能。進捗表示はファイル翻訳="X/Y units"、ディレクトリ翻訳="X/Y files"形式。

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

### term（用語集）

- `mdait.term.detect`: 原文ユニットをバッチ化し、AIで用語候補を抽出。既存用語集とマージして保存。
- `mdait.term.expand`: 原文用語ユニットを抽出し、原文/訳文ペアから用語訳を推定。未解決語はAI翻訳で補完し`terms.csv`へ反映。
- **並列実行制御**: ディレクトリ処理時はファイルを順次処理（trans翻訳と同様の理由）。バッチサイズはAI APIの入力トークン制限に応じて調整。

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
	participant AI as AIService

	UX->>Cmd: 対象言語指定
	Cmd->>Repo: 未解決用語取得
	Cmd->>Cmd: Unitペア抽出・バッチ化
	loop 各バッチ
		Cmd->>AI: 原文+訳文と用語リスト送信
		AI-->>Cmd: 用語訳ペア
	end
	Cmd->>Repo: CSV更新
	Repo-->>UX: 保存完了通知
```

## 考慮事項

- すべてのコマンドはVSCode標準の`withProgress`パターンで`CancellationToken`対応と冪等性確保を優先する。
- 設定は[config.md](config.md)で定義されたシングルトン経由で最新値を取得する。
- 翻訳や用語抽出など外部呼び出しは[api.md](api.md)のビルダーで動的にプロバイダー切り替えを行う。

## 参照

- 実装コード: `src/commands/` 以下
- UI連携: [ui.md](ui.md)
- テスト観点: [test.md](test.md)