# UI

> [architecture](../design.md) > **UI**

## このドキュメントの責務

UI層は、mdaitの内部状態をVS Code標準UIパターンで可視化し、ユーザーに直感的な操作体験を提供します。

**設計意図**: VS Codeネイティブな体験を提供します（[design.md](../design.md) P6参照）。TreeView、CodeLens、Hover、Progressなど、VS Code標準のUI要素を活用することで、他の拡張機能と一貫したUXを実現し、ユーザーの学習コストを低減します。独自Webビューは原則使いませんが、mdait.json 設定エディタのみ例外として Webview を採用しています（ADR-260711-01。見た目・操作モデルはVS Code設定画面に準拠）。

本ドキュメントは UI **部品**のカタログである。ジャーニー全体・UX原則（デッドエンド禁止・判断サーフェス・工程間の手渡し等）・課題台帳は [ux.md](../ux.md) を正準とし、部品の追加・変更時は ux.md の原則との整合を確認すること。

---

## 主要コンポーネント

### StatusTreeProvider

`StatusItemTree`をVS Code TreeViewに変換し、翻訳状態を階層的に表示します。

**機能**:
- needフラグをアイコンとバッジで視覚化
- frontmatterを含む場合は先頭に表示（ファイル翻訳の前にfrontmatter翻訳を実行可能）
- ステータスに変更があれば**ツリー全体を再描画**する（どのノードを描き直すかは判定しない。ADR-260724-01）
- `Configuration.isConfigured()`がfalseの場合は空配列を返しリソース消費を抑制

**設計意図**: ツリー構造により、ディレクトリ→ファイル→ユニットという自然な階層でステータスを把握できます。

#### 更新通知のモデル（ADR-260724-01）

`StatusItemTree` の変更は宛先を持たない「変更あり」1本のシグナル（ペイロードなし）として `StatusManager` に届き、`StatusManager` がデバウンス（既定80ms）で束ねて全体再描画を1回だけ通知する。以前は「このディレクトリ配下だけ」という部分通知を宛先付きで発行していたが、その宛先判断が「要対応ノードだけ更新されない」不具合の発生源であったため、判断そのものを設計から削除した。

この方式が成り立つ前提は2つある。**変更する場合は前提が崩れていないか確認すること**。

1. **全体再描画は安価である**: VS Code が再取得するのは可視かつ展開済みのノードだけであり、`getChildren` / `getTreeItem` はインメモリのマップ参照のみでディスクI/Oを伴わない。ディスクを読み直す重い処理は `StatusManager.buildStatusItemTree()` であり、これは全体再描画とは別物である。
2. **`treeItem.id` が安定している**: 展開・選択状態は id で保持されるため、全体再描画でもツリーが畳まれない。id 採番（ディレクトリ／ファイルはワークスペース相対パス、ユニットは `相対パス#ハッシュ`）を変更する場合は、展開状態が維持されることを必ず確認すること。

デバウンスは通知を束ねるためのものであり、遅らせるためのものではない。守るべき性質は2つで、いずれも `StatusManager` の単体テストで保証している。

- 最後の変更から必ず1回通知される（取りこぼさない）
- 変更が待ち時間より短い間隔で続いても、上限（既定300ms）を超えたら通知する。これが無いとディレクトリ一括 sync の最中にツリーが凍って見える

#### Needs Attention（要対応キュー）

ルート直下の仮想ノード。`need:review` / `need:verify-deletion` のユニットを、**選択中の transPair の範囲で**横断集約する（範囲の算出はツリー本体と共通の `getSelectedScopeDirs`。算出点が分かれると、ツリーに出ていないファイルの項目が要対応にだけ並ぶ）。

- 件数ラベルと子リストは同じ集約結果から作られる（以前は件数だけがルート構築時のスナップショットで固まり、中身と食い違っていた）
- 並びはファイルパス昇順→開始行昇順で固定。同じ状態なら常に同じ並びになる
- 項目の副題（`description`）に `ファイル名 · 種類` を出す（見出しタイトルだけでは同名の見出しを区別できないため）
- 0件のときはノードごと出さない（UX-P7: デッドエンドを置かない）
- ノードが現れた最初の1回だけ展開状態で返す。全体再描画のたびに展開し直すと、ユーザーが畳んでも保存のたびに勝手に開いてしまうため
- 集約範囲は LM Tools の集計（`mdait_getStatus` 等）とも共通で、人間とエージェントの件数は一致する（ADR-260724-01）
- **「次の要対応へ」**（`mdait.needsAttention.next`）で、現在位置の次の項目へ1操作で移動できる。末尾まで来たら先頭へ回る。導線は CodeLens の裁定ボタンの隣・要対応ノードのインラインボタン・キーバインド（`ctrl+alt+n` / `cmd+alt+n`）の3つ。裁定直後に自動で画面が飛ぶことはしない（UX-P5）

#### コンテキストメニューの表示制御

StatusTreeは`contextValue`プロパティを使用して、VS Codeのwhen条件で各コマンドの表示を制御します。

**contextValueの種類**:
- `mdaitFileSource` / `mdaitDirectorySource`: ソースファイル/ディレクトリ（用語集検出コマンド用）
- `mdaitFileTarget` / `mdaitDirectoryTarget`: 翻訳未完了のターゲットファイル/ディレクトリ
- `mdaitFileTargetComplete` / `mdaitDirectoryTargetComplete`: 翻訳完了のターゲットファイル/ディレクトリ（TM登録・用語集展開コマンド用）

**contextValueの設定**:
ターゲットファイル/ディレクトリは、翻訳状態に応じて以下のいずれかのcontextValueを持ちます：
- 未完了: `mdaitFileTarget` / `mdaitDirectoryTarget`
- 完了: `mdaitFileTargetComplete` / `mdaitDirectoryTargetComplete`

**package.jsonのwhen条件**:
- 翻訳コマンド: `viewItem == mdaitFileTarget || viewItem == mdaitFileTargetComplete` （完了・未完了両方で表示）
- TM登録等: `viewItem == mdaitFileTargetComplete` （完了時のみ表示）

**翻訳完了判定** (`Status.Translated`):
- すべてのユニットが`status === Status.Translated`
- frontmatterも翻訳済み（存在する場合）
- ディレクトリの場合、直下のファイルとサブディレクトリすべてが完了状態

**エッジケース**:
- **空ファイル**: 翻訳すべき内容がないため完了扱い (`mdaitFileTargetComplete`)
- **エラーファイル**: パースエラーがある状態は不完全 (`mdaitFileTarget`)
- **空ディレクトリ**: ファイルもサブディレクトリもない場合は不完全扱い

**非MDファイルの表示**:
- ユニット分割されないため、**リーフノード（子ノードなし、collapsibleState: None）** として表示
- ステータスは `UnitStateStore` のneedフィールドから直接決定（`need:''` → Translated、`need:translate` → NeedsTranslation等）
- ファイルサイズが `trans.maxFileSize` を超過する場合、tooltipに超過理由を表示
- CodeLens・Hover・SummaryDecoratorの非MD対応は将来の拡張スコープ

---

### Welcome View

`mdait.json`未設定時に表示される初期設定ガイドです。

**機能**:
- `viewsWelcome`でギアアイコンCTAを表示
- `mdait.setup.createConfig`コマンドにリンク
- `mdaitConfigured`コンテキスト変数で表示を制御

**設計意図**: 初回利用時の「何をすればいいか分からない」状態を解消し、スムーズなオンボーディングを実現します。

---

### 設定エディタ（SettingsPanel / SettingsEditorProvider）

VS Code設定画面ライクな mdait.json 編集用 Webview です（P6 の例外、ADR-260711-01・ADR-260711-02）。`mdait.json` を直接エディタで開いた場合も、`CustomTextEditorProvider`（`SettingsEditorProvider`、`priority: "default"`）により標準JSONエディタの代わりにこの設定UIがデフォルト表示されます。ステータスビューのツールバー（ギアアイコン）・コマンドパレット・エディタで直接開く、のいずれからも同じ設定UIに到達します。

**JSON表示との切り替え**:
- Markdownプレビューの表示切り替えボタンと同様に、エディタタイトルバーのボタンで設定UI ⇔ 生JSONを切り替えられる（`mdait.settings.openAsJson` / `mdait.settings.openAsUi`、`when: activeCustomEditorId == mdait.settingsEditor` で排他表示）
- 内部的には同一タブ上で `vscode.openWith` によりエディタ種別を切り替える（新規タブは開かない）
- 設定UI内の「JSONで編集」ボタンも同じ仕組みで生JSONへ切り替わる

**スキーマ駆動生成**:
- UI は `assets/schemas/mdait-config.schema.json` から実行時に自動生成（`settings-model.ts`、純粋ロジック）
- カテゴリ = スキーマのトップレベルキー（スカラーは general に集約）。型に応じたウィジェット（boolean/enum/数値/文字列/文字列配列/transPairs 表エディタ）を割り当てる
- 生成器が未対応の形（`copyAssets` のような boolean|array の oneOf 等）は「JSONで編集」フォールバック行として表示
- 解説文は `settings-doc.ts` に集約し l10n で日英提供。未定義の設定はスキーマ description にフォールバックするため、スキーマへの設定追加だけでも UI は機能する

**編集の仕組み**:
- 検索・カテゴリナビ・変更済みインジケータ（modified バー）・既定値リセットを提供
- 書き込みはキー単位の最小差分（`src/infra/config/config-json-editor.ts`。markers-migration とも共有される mdait.json 書き換えの単一経路）。既存キーの順序・インデント・末尾改行を保持し、リセットはキー削除＋空になった親オブジェクトの刈り取り
- 検証・型変換・パス解決（`Configuration` 経由）・ファイルI/Oはすべて拡張側（`settings-panel.ts`）。Webview は表示に徹する
- 外部編集（エディタでの直接編集等）は `Configuration.onConfigurationChanged` 経由で UI に反映。入力中のウィジェットは上書きしない
- mdait.json 未作成時はパネルを開かず `mdait.setup.createConfig` へ誘導

**設計意図**: 50項目超の設定の発見可能性を高め、スキーマを唯一の真実源とすることで UI とスキーマの二重管理を避けます。

---

### CodeLens機能

mdaitマーカー上に表示されるインラインアクションボタンです。VS CodeのCodeLens機能を利用してテスト実行ボタンのような直感的なUIを提供します。

#### 表示されるCodeLens

**ターゲットファイル（訳文）のマーカー**:
- **$(symbol-reference) Source**: 原文ユニットへジャンプ（`from`属性がある場合）
- **✨[AI]翻訳**: AI翻訳を実行（`need:translate`がある場合）
- **$(check) 完了マーク**: needフラグを手動でクリア（`need`属性がある場合、種類に応じたラベル）
- **$(check) Keep / $(trash) Delete Unit**: `need:verify-deletion` の2択（Delete は modal 確認つき）
- **$(arrow-right) Next**: 次の要対応ユニットへ（`need:review` / `need:verify-deletion` のとき）
- **$(kebab-vertical) その他**: QuickPick メニュー（`from`と`hash`がある場合）。「独立扱いにする」（`need`なし時のみ）と「ノート」を集約（`mdait.codelens.otherActions`）

**ソースファイル（原文）のマーカー**:
- **$(symbol-reference) Target**: 訳文ユニットへジャンプ（`from`属性がなく、対応する訳文が存在する場合）
- 複数の訳文言語がある場合、`transPairs`設定順で最初のターゲットへジャンプ
- **$(kebab-vertical) その他**: 訳文側と同じメニュー（原文側は `hash` があれば表示）。原文側の isolate 宣言（sync が `need:translate` を生成しなくなる。ADR-260706-02）と原文側ノート（audit 時に `from` ハッシュ経由で AI に渡る）に対応

**frontmatterマーカー**:
- **$(play) 翻訳**: frontmatter翻訳を実行（`need:translate`がある場合のみ）
- **$(check) 完了マーク**: frontmatter needフラグをクリア（`need`がある場合のみ）
- **翻訳完了後（`from`あり、`need`なし）**: CodeLensを表示しない
  - 理由: TM登録・確定は非対応、原文は同ファイル内のため移動不要

**TM登録**: StatusTreeのファイル/ディレクトリコンテキストメニューから利用可能。ユニット単位のTM登録CodeLensは廃止された。

#### ジャンプ時の動作

- 右側（Beside）に分割表示でジャンプ先を開く
- 左右のユニットをハイライト表示（find match風の背景色）
- 左側のスクロールに右側が追従する一方向スクロール同期
- カーソルがハイライト範囲外に移動、または右側を手動スクロールすると同期解除

**設計意図**: 原文と訳文を並べて確認できることで、翻訳品質のレビューが容易になります。

#### 実装の詳細

- **Provider**: `MdaitCodeLensProvider`がドキュメント内のマーカーを検出し、適切なCodeLensを生成
- **Command**: `codeLensJumpToSourceCommand`, `codeLensJumpToTargetCommand`, `codeLensTranslateCommand`, `codeLensClearNeedCommand`等がアクションを実行。**マーカーの書き換えは自分で行わず `getFileHandler` 経由で実行する**（排他制御・ステータス更新の取りこぼしを防ぐため。`commands/markers/unit-mutation.ts`）
- **パフォーマンス**: ソースファイル判定は`FileExplorer.isSourceFile()`でO(transPairs数)、ターゲット検索は`StatusItemTree.getTargetUnitByFromHash()`で優先検索→全体検索のフォールバック

---

### 翻訳サマリ表示

翻訳完了後、処理時間、トークン数、用語候補、警告をユーザーに提示します。あわせて「手で訳したが未確定」のユニットの状態と解説もこの2つのサーフェスが担います（サーフェスの役割分担は [ux.md](../ux.md) §3.3 が正準）。

#### TranslationSummaryHoverProvider

mdaitマーカー行およびfrontmatterマーカー行にホバーしたときに翻訳サマリを表示します。

**表示内容**:
- 処理時間
- トークン数
- TM参照ヒット（`source → target`形式）
- 用語候補（各候補に「用語集に追加」リンク。`command:` URI 経由で `mdait.addToGlossary` を起動する唯一の導線）
- 警告

**実装**: `SummaryManager`からハッシュをキーにサマリ情報を取得し、Markdown形式でリッチ表示

**手で訳したが未確定のユニット**: サマリが無くても `MdaitMarker.hasUnconfirmedEdit()` が真なら、「手作業で翻訳完了した場合は『翻訳済みにする』を押す」旨の解説を出す。訳文を書いただけでは need は落ちないため、それを知らないと「訳したのに進捗が動かない」で手が止まる。解説の置き場は Hover に限る（CodeLens は操作専用。ADR-260801-03）

#### SummaryDecorator

翻訳サマリの概要をマーカー行末尾にGitLens風のインライン表示で提供します。

**特徴**:
- frontmatterマーカーも対象に含む
- CodeLensと同じ色・フォントスタイルで統一
- 詳細はHoverで確認可能
- サマリが無くても、手で訳して未確定のユニット（`hasUnconfirmedEdit()`）には `編集済み — まだ完了にしていません` を出す。状態は気づける場所に置き、理由と対処は Hover に置く（ADR-260801-03）

**設計意図**: エディタを開いたまま、翻訳の統計情報を一目で確認できます。

#### SummaryManager

翻訳実行時に生成されたサマリデータ(`TranslationSummary`)をメモリ上でMap管理するシングルトンです。

**特徴**:
- 永続化は不要で、VS Code再起動時にクリアされる
- 翻訳完了時に`trans-command`から呼び出され、Hover/Decorator表示時に参照される

---

### Progress Reporter

sync/trans/term実行中の進行状況を表示し、`CancellationToken`でユーザーからの中断を処理します。

**設計意図**: 長時間処理でもユーザーが状況を把握でき、必要に応じて即座にキャンセルできます（[design.md](../design.md) 哲学4参照）。

---

## 更新シーケンス

### ステータス更新フロー

```mermaid
sequenceDiagram
	participant User as User
	participant UI as StatusTreeProvider
	participant Cmd as Command層
	participant Mgr as StatusManager
	participant Tree as StatusItemTree

	User->>UI: コマンド起動
	UI->>Cmd: 引数を渡して実行
	Cmd->>Mgr: refreshFileStatus / changeUnitStatus
	Mgr->>Tree: addOrUpdateFile / removeFile / updateUnit
	Tree-->>Mgr: 変更あり（宛先なしの1本のシグナル）
	Mgr-->>UI: 80msで束ねて全体再描画を通知
	UI-->>User: 可視ノードを再取得して表示更新
```

変更の宛先は誰も判定しない。翻訳中のようにユニット単位の更新が連続しても、デバウンスが1回の再描画にまとめる（ADR-260724-01）。

**自動同期のトリガー**:
- ドキュメント保存時は`workspace.onDidSaveTextDocument`で対象ファイルを検知
- `sync.autoSyncOnSave`が`true`（デフォルト）で、mdaitマーカー（ユニットまたはフロントマター）が存在する場合のみ、`syncSingleFile`を呼び出して自動同期を実行
- まだ一度もsyncしていないファイル（マーカーが存在しないファイル）は自動同期の対象外

**設計意図**: 原文編集直後に自動同期が走ることで、翻訳が必要な箇所が即座に可視化されます。マーカーが存在しないファイルは意図的に除外することで、mdait管理外のファイルに対する不要な処理を防ぎます。

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

**設計意図**: 翻訳完了後、`SummaryManager`にサマリを保存し、`SummaryDecorator`がマーカー行末尾に簡潔な統計を表示します。詳細情報は`HoverProvider`でオンデマンド提供することで、エディタが情報で溢れることを防ぎます。

---

## 視覚表現の原則

- **needフラグ別の固定アイコン**: どの画面でも同じ記号で意味が伝わる一貫性
- **進捗表示の簡潔さ**: ファイル単位で「翻訳済み/要翻訳/エラー」の数値を表示し、折りたたみ表示でも情報が埋もれない
- **l10nシステム**: `/l10n`配下で文言を管理し、日本語/英語を等価に提供

**設計意図**: VS Code標準のアイコンとスタイルを活用することで、ユーザーが直感的に理解できるUIを実現します。

---

## ナビゲーションボタン

ステータスビューのツールバー（`view/title`メニュー）に配置されるナビゲーションボタンです。

**用語集を開く** (`mdait.status.openTerm`):
- **アイコン**: `$(repo)`
- **機能**: `.mdait/`配下の用語集ファイルをVSCodeエディタで開く
- **表示条件**: `mdaitConfigured && mdaitHasStatus`
- **エラーハンドリング**: ファイルが存在しない場合は情報メッセージを表示

**TMを開く** (`mdait.status.openTm`):
- **アイコン**: `$(database)`
- **機能**: `.mdait/translations.tmx`をVSCodeエディタで開く
- **表示条件**: `mdaitConfigured && mdaitHasStatus`
- **エラーハンドリング**: ファイルが存在しない場合は情報メッセージを表示

**設計意図**: 用語集とTMファイルに素早くアクセスできることで、翻訳品質の確認・編集が容易になります。用語集は「本」アイコン（`$(repo)`）、TMは「データベース」アイコン（`$(database)`）で視覚的に区別します。

**検証** (`mdait.validate`):
- **配置**: ツールバーのオーバーフロー（`…`）メニューとコマンドパレット。行内ボタンは増やさない（露出過多の回避。ux.md E-7 の教訓）
- **機能**: 構造チェック＋用語一貫性検証（読取専用・AI不使用・確認UIなし）。結果は `.mdait/reports/validate.md` へ書き出し、完了通知の「レポートを開く」ボタンから開く
- **対称性**: エージェント側の `mdait_validate` と同一のコア（`validate_CoreProc`）を使う（UX-P1）

---

## コマンドID正準リスト

`mdait.*` コマンドの正準台帳。**新しいコマンドを追加したらこの表も更新すること**（package.json・extension.ts と本表の乖離は「宣言と実体の齟齬」として扱う）。導線列の凡例: パレット=コマンドパレット、ツリー=StatusTree（タイトルバー/行内/コンテキストメニュー）、内部=UIサーフェスから直接は呼ばれない。

| コマンドID | 導線 | 備考 |
|---|---|---|
| `mdait.sync` / `mdait.validate` / `mdait.setup.*` / `mdait.settings.open` / `mdait.markers.externalize` / `mdait.markers.embed` / `mdait.translateSelection` / `mdait.adopt.run` / `mdait.tm.optimize` | パレット（一部はツリーにも） | スタンドアロンで動作するもののみパレットに露出（ux.md C-2） |
| `mdait.translate.{directory,file,unit,frontmatter}` / `mdait.term.{detect,expand}.{directory,file}` / `mdait.tm.commit.{file,directory}` / `mdait.aiReview.{file,directory}` | ツリー行内/コンテキストメニュー | アイテム引数必須のためパレット非表示 |
| `mdait.unit.{markReviewed,keep,delete,markIsolated,unisolate}` / `mdait.needsAttention.next` / `mdait.jumpToUnit` | ツリー/CodeLens/キーバインド | 判断サーフェス（ux.md J4）。書き換えは `getFileHandler` 経由 |
| `mdait.codelens.*` / `mdait.unit.editNoteForUnit` | CodeLens | エディタ内インラインアクション専用 |
| `mdait.status.{sync,sync.initial,selectTargets,openTerm,openTm}` | ツリータイトルバー | `mdait.status.sync.processing` はハンドラを持たない表示専用ダミー（`enablement: false` のスピナー表示枠） |
| `mdait.addToGlossary` | Hover の `command:` URI | package.json 未宣言（Hover 起点が正しい導線のため意図的） |
| `mdait.trans` / `mdait.term.detect` / `mdait.term.expand` | 内部 | テスト・デバッグIPC・他コマンドからの内部呼び出し専用。パレットに出さない |
| `mdait.trans.pendingTargets` | 内部 | sync 完了通知の「今すぐ翻訳」の実体。翻訳待ちが残る訳文ルートを対象にする（複数ペアなら QuickPick）。`mdait.trans` は URI 必須のため、この導線からは呼べない |

---

## コンテキスト変数

### mdaitConfigured

**用途**: 設定完了状態を示すコンテキスト変数

**動作**:
- `Configuration.isConfigured()`の結果に基づき更新
- `true`の場合はツールバーボタン（sync/filter/glossary）を表示
- `false`の場合はWelcome Viewを表示
- activation時と設定変更(`Configuration.onConfigurationChanged`)時に更新され、UI全体の表示状態を制御

**設計意図**: 未設定状態を明示し、ユーザーに次のアクション（設定ファイル作成）を促します。
