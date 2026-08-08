# Core

[architecture](../design.md) > **Core**

Core層は翻訳ドメインの純粋なロジック（ユニット解析・ハッシュ・ステータス・TM）をVS Code API非依存のモジュールとして提供します。

## mdaitUnit

mdaitUnitとはMarkdown文書を翻訳管理単位（ユニット）に分割したものです。見出しまたはmdaitマーカーを境界とし、本文・マーカー・位置情報の3要素を持ちます（[design.md](../design.md) P1参照）。

### 構造

mdaitUnitは以下の要素で構成されます：

- **content**: ユニット本文（Markdownテキスト）
- **marker**: `<!-- mdait {hash} [from:{hash}] [need:{flag}] -->`
- **range**: ドキュメント内の開始・終了位置

| フィールド | 意味 |
|---|---|
| `{hash}` | ユニット本文のCRC32ハッシュ（8文字）（巡回冗長検査による高速ハッシュ関数） |
| `from:{hash}` | 訳文の翻訳元ユニットのハッシュ（訳文ファイルのみ） |
| `need:{flag}` | 要求フラグ（下記の need 語彙表参照） |

**例**（before/after）:

before（マーカーなし）:
```markdown
## 概要
This is the introduction section.
```

after（sync後）:
```markdown
<!-- mdait 3f7c8a1b need:translate -->
## 概要
This is the introduction section.
```

### need 語彙

need と from の組み合わせがユニットの状態を表す（正準表。孤立関連の背景は [command_sync.md](command_sync.md) の「孤立ユニットモデル」、TM commit 可否の根拠は [command_tm.md](command_tm.md)）:

| need | from | 意味 | trans対象 | TM commit対象 |
|---|---|---|:---:|:---:|
| なし | あり | 通常の対訳（同期済み） | ✕ | ✅ |
| なし | なし | **独立ユニット**（訳文役割の孤立。上流なし・下流へは伝播する起点） | ✕ | ✕（noFrom） |
| `translate` | あり | 未翻訳 | ✅ | ✕ |
| `revise@{h}` | あり | 原文改訂により再翻訳待ち | ✅ | ✕ |
| `review` | あり/なし | 人間ゲート（adopt採用・穴あき一次受け） | ✕ | ✕ |
| `isolate` | あり/なし | **保持＋下流伝播停止**（原文役割の孤立／真のローカル） | ✕ | ✕ |
| `verify-deletion` | あり/なし | 原文削除に伴う削除確認 | ✕ | ✕ |

レガシーの `need:keep` / `need:backfill` は廃止済みで、sync 時に `normalizeLegacyNeeds` が決定的に移行する（keep→need除去、backfill→review。ADR-260711-05）。

### ユニット境界の決定

1. **見出しレベル**: `mdait.json`の`sync.level`で指定されたレベル以下の見出し
2. **mdaitマーカー**: `<!-- mdait -->` または `<!-- mdait {hash} ... -->`

**ルール**: マーカーの直後（空行なし）に見出しがある場合、その見出しがユニットのタイトル。ハッシュ省略マーカー `<!-- mdait -->` も境界として認識され、sync時に自動計算される。

### level設定のドキュメント単位オーバーライド

Frontmatterで`mdait.sync.level`を指定することでファイル単位でユニット粒度を変更できます。sync実行時、原文と訳文でlevel設定が異なる場合は**原文の設定を優先して訳文を自動修正**し、マーカー対応付けの破綻を防止します。

```typescript
// 使用例: MarkdownテキストをmdaitUnit配列に変換
const units = parseMarkdown(markdownText, config);
// units[0].content, units[0].marker, units[0].range で各要素にアクセス
```

**実装**: [`src/core/markdown/parser.ts`](../../src/core/markdown/parser.ts)

## Hash & Normalizer

行末空白・連続空行・コードフェンス言語指定・リンク参照順序の差異を吸収し、本質的な内容変更のみを検出します（[design.md](../design.md) P2参照）。

```mermaid
graph LR
    A[ユニット本文] --> B[正規化]
    B --> C[CRC32計算]
    C --> D[8文字短縮ハッシュ]
```

**CRC32の選択理由**: SHA-256と比べてハッシュが短くマーカーが肥大化しない。同一内容から必ず同じハッシュを生成する決定的計算で、数千ユニット規模での衝突リスクは極めて低い。

**実装**: [`src/core/hash/`](../../src/core/hash/)

## Status管理

ディレクトリ/ファイル/ユニット階層をMap構造で保持し、O(1)（定数時間）検索を実現します（[design.md](../design.md) P3参照）。ファイルごとに再計算することで、個別ファイルの変更時に全体を走査する必要がありません。

### StatusItemTree

```typescript
interface StatusItemTree {
  dirs: Map<string, DirectoryStatus>;
  files: Map<string, FileStatus>;
  units: Map<string, UnitStatus>;
}
```

### StatusManager

StatusCollector（Commands層）とUIの橋渡しとして全体構築・部分更新を担います。StatusCollectorはCommands層に配置されているため、`StatusCollectorPort`インターフェース（Core層定義）を介したDI注入で接続します。

**主要メソッド**: `refreshFileStatus(filePath)` / `getFileStatus(filePath)` / `clear()` / `setCollector(collector)`

```typescript
// 使用例: activate時にCollectorをDI注入
const manager = StatusManager.getInstance();
manager.setCollector(new StatusCollector());
// ファイル変更時のステータス更新
await manager.refreshFileStatus(filePath);
```

### StatusCollectorPort

Core層に定義されたポートインターフェース。StatusManager（Core層）がCommands層のStatusCollectorに直接依存しないよう、DI境界を提供します（[design.md](../design.md) P5参照）。

```typescript
export interface StatusCollectorPort {
  collectFileStatus(filePath: string): Promise<FileStatusItem>;
  buildStatusItemTree(): Promise<StatusItemTree>;
}
```

Commands層の`StatusCollector`がこのインターフェースを実装し、`extension.ts`のactivate時に`StatusManager.setCollector()`で注入します。collector未設定時はwarnログを出力してスキップします。

**実装**: [`src/core/status/status-collector-port.ts`](../../src/core/status/status-collector-port.ts)、注入先: [`src/core/status/status-manager.ts`](../../src/core/status/status-manager.ts)

**実装（StatusManager）**: [`src/core/status/`](../../src/core/status/)

## UnitRegistry管理

ユニット内容を`.mdait/unit-registry`ファイルで永続化します。原文変更時、旧コンテンツとの差分生成に使用します。あわせて、ユニットに紐づく**note**（人間/ツールのメタ情報。audit 時に AI へ渡される意図的乖離の説明など）を同一 hash キーで保持します（ADR-260708-01）。

**保存形式**: 1エントリ `<hash> <encContent>[ <encNote>]`（3列目=note は任意。旧2列ファイルと後方互換）。content・note とも gzip圧縮 + base64エンコード。CRC32先頭3桁でバケット化し、バケット昇順でgit競合を軽減。

```
3f7
3f7c8a1b <encoded_content>
a2b
a2b5c7d8 <encoded_content> <encoded_note>
```

- **content**: content-addressed で不変（旧内容は revise の差分生成に必要なので残す）
- **note**: ユニットに追従する恒久メタ。本文編集で hash が変わると sync（`updateSectionHashes`→`migrateNotes`）が旧→新 hash へ移送する（決定的・冪等・AI 不使用）

**GC処理**: sync完了後、ファイルサイズが5MB超過時に使用中のhash以外のレジストリ（content・note とも）を削除します。

**実装**: [`src/core/unit-registry/`](../../src/core/unit-registry/)

## UnitState管理

翻訳ユニットの状態を `.mdait/unit-state` で管理します。非Markdownファイル（.txt, .csv等）はファイル内にHTMLコメントマーカーを埋め込めないため、また MD-external モード（マーカー外部化）でも本文にマーカーを残さないため、外部ストアで状態を永続化します。**非MDファイルは「ファイル＝単一ユニット」= MDユニットの N=1 特殊形**として同じストアで扱います。

**保存形式**: TSV（タブ区切り）。`path・order・level・titleHash・hash・from・need` の7カラム。複合キー `(path, order)` でユニットを識別し、`path → order` の二段で昇順ソートしてgit diffを読みやすくします。非MDファイルは `order=0, level=0, titleHash=""` の1行、MD-external は同一 path に複数 order 行を持ちます。

```
# mdait unit-state — 翻訳ユニットの状態管理
# path	order	level	titleHash	hash	from	need
docs/en/data.csv	0	0		11223344	55667788	translate

docs/en/guide.md	0	1	aa11bb22	a1b2c3d4	ff03a1b2	
docs/en/guide.md	1	2	cc33dd44	99887766	55443322	translate
```

（path 境界に空行アンカーを入れてファイルごとのブロックを分離する。下記「git 競合回避」を参照）

**UnitRegistryとの関係**: UnitStateStoreはパス＋順序ベースのメタデータ管理（(path,order)→hash/from/need）、UnitRegistryはコンテンツアドレスストア（hash→content）。revise時に旧コンテンツが必要なため、sync時にUnitRegistryへ保存します。両者は役割が異なるため統合しません。

**実装**: [`src/core/unit-state/unit-state-store.ts`](../../src/core/unit-state/unit-state-store.ts)

> 互換性に関する注意: 旧 `.mdait/file-state`（4カラム）は読み込みません。初回 sync で `.mdait/unit-state` を再構築します（非MDの rebuild は `need:review` 付与で安全網）。旧ファイルは手動削除して構いません。

**git 競合回避（ADR-260624-01）**: `.mdait/unit-state` は全ファイルの状態を集約する単一TSVのため、external での並行翻訳で競合しやすい。これを最小化するため、(1) `ensureMdaitDir()` が `.mdait/.gitattributes` に `unit-state merge=union` を冪等生成し（別ファイル/別ユニットの編集を自動マージ）、(2) `save()` が path 境界に空行アンカーを挿入してファイルごとのブロックを分離する（ローダーは空行スキップ済みで読み込み不変）。union が生む重複行は次 `load()` の Map デデュープ（後勝ち）＋ `save()` 正準化で畳まれ、最終的に sync のハッシュ再計算とストア欠落時の `need:review` で吸収される（unit-state は派生キャッシュ）。

### MD-external モードの配線

保管方式はグローバル設定 `markers.mode: "embedded"|"external"`（既定 embedded、`Configuration.isExternalMarkers()`/`getMarkerProvider()`）で決まります。「管理下ファイルの読み書き」経路（sync / trans / status-collector / md-file-handler の `isInitialized` / CodeLens / Hover / Decorator / migration）でのみ [`resolveMarkerIO(config, absPath, role)`](../../src/infra/config/marker-io.ts) が provider と ctx（`toWorkspaceRelativePath` によるワークスペースルート相対パス + role）を解決して `parse`/`stringify` に注入します。external では本文にマーカーが無いため、trans は全文 stringify で書き戻し（`saveExternalDocument`）、UI は [`findUnitAtLine`](../../src/core/markdown/unit-locator.ts) でユニット行範囲からマーカーを特定します。TM/term など非対象経路は embedded 既定のまま据え置きます。

embedded↔external の一括変換は [`markers-migration.ts`](../../src/commands/markers/markers-migration.ts)（コマンド `mdait.markers.externalize` / `mdait.markers.embed`）が担います。externalize はマーカー除去後の本文を external 境界で再 parse し、(headingLevel, title) の部分列一致で embedded 側のマーカーを移送してから store へ退避します（サブ境界の統合で order がずれ、後続ユニットの状態を取り違えるのを防ぐ。ADR-260731-03）。embed は external parse（store から attach）→ embedded stringify です。完了後の `markers.mode` 書き戻しは `infra/config/config-json-editor` の `setConfigValue` 経由で、既存の整形を保持します。frontmatter マーカーは両モードとも in-file（対象外）、手動サブ境界マーカーは external 非対応です（変換前の確認ダイアログで警告）。

## Diff生成

trans実行時、旧レジストリと現在のコンテンツから差分を生成します。LLMには`=`/`-`/`+`プレフィックス形式のパッチを入出力フォーマットとして用い、機械的に適用可能な変更指示をやり取りすることで、変更箇所以外の既存訳文を維持します（[design.md](../design.md) P4参照）。一方で、ユーザーが確認するための差分ビュー（例: VS Code上のdiff表示やログ・レビュー用のdiff）にはunified diff形式を用い、その生成には`diff`パッケージを使用します。

**実装**: [`src/core/diff/`](../../src/core/diff/)

## FrontMatter翻訳

frontmatter（MarkdownファイルのYAML前付き情報）内の`mdait.front`フィールドで翻訳状態を管理します。`trans.frontmatter.keys`で指定されたキーの値をkeys順に連結してハッシュ化し、`FrontMatter`クラスのドット記法（例: `"mdait.sync.level"`）による階層アクセスをサポートします。mdait管理外のフィールドは元のYAMLフォーマットを維持します。

```yaml
mdait:
  front: "abc12345"                              # 初回翻訳前（fromなし）
  # または
  front: "abc12345 from:def67890 need:translate"  # 更新時
```

**実装**: [`src/core/markdown/frontmatter-translation.ts`](../../src/core/markdown/frontmatter-translation.ts)

## マーカー正規化

mdaitマーカー直前の空行を保証し、markdown-itが段落区切りを正しく認識できるようにします。

**実装**: [`src/core/markdown/parser.ts`](../../src/core/markdown/parser.ts) (`normalizeMarkerSpacing`)

## 翻訳メモリ（TM）

翻訳メモリ（TM）は過去の翻訳事例をデータベース化し、類似文の再翻訳を支援する仕組みです。TMXはTM交換標準フォーマット（XML）で、mdaitでは`.mdait/translations.tmx`に保存します。

### TmxStore

TMXファイル（`.mdait/translations.tmx`）のI/Oとインメモリインデックスを担当します。

- TMX XMLパース/シリアライズ（`fast-xml-parser`）・`Map<tuid, TmEntry>` による高速検索（O(1)）
- CRUD: primary anchor lookup、`existing TM set` 取得、variant upsert、retrieval 用 batch lookup
- **trigram 転置インデックス** `Map<lang, Map<trigram, Set<tuid>>>`: variant テキストを `normalizeForTm` した trigram を lang 別に事前構築。`findCandidatesByTrigram(rawText, lang, limit)` でクエリの正規化・粗絞り込みを内部完結
- **trigramCache** `Map<"${tuid}:${lang}", Set<string>>`: `indexEntry` 時に variant trigram を保存するフォワードキャッシュ。`getTrigramCache()` で読み取り専用ビューを返し、ランカーが再計算を回避する
- グローバル遅延シングルトン（`getInstance(tmxFilePath)`、ファイル更新時刻（mtime）ベースの自動リロード）

**データモデル**: `tuid = hash(norm(primary sentence))` をキーとし、primary 文面と各言語 variant、その provenance を保持する TU 単位の TmEntry。`x-source-hash` はユニット再処理抑止のための補助インデックスであり、TU 同一性のキーではありません。

```typescript
interface TmEntry {
    tuid: string;
    primary: string;
    variants: Map<string, {
        text: string;
    }>;
}
```

```typescript
// 使用例: Command層からの典型的な呼び出し
const store = TmxStore.getInstance(tmxPath);
// primaryLang を持つ全TUを取得（フィルタリングはCommands層の責務）
const allEntries = store.getEntriesByUnitPath(primaryUnitPath, primaryLang, localLang);
const matches = store.lookupBatch(sentenceHashes, sourceLang, targetLang);
store.save(tmxPath);
```

**実装**: [`src/core/tm/tmx-store.ts`](../../src/core/tm/tmx-store.ts)

### SentenceSplitter

`Intl.Segmenter`ベースの文分割。コードブロック/インラインコード保護、段落・リスト項目の独立分割に対応し、言語ごとにSegmenterをキャッシュして日英中の文境界を検出します。

**実装**: [`src/core/tm/sentence-splitter.ts`](../../src/core/tm/sentence-splitter.ts)

### TmTextNormalizer

TM登録・検索時にMarkdown要素を除去し、翻訳価値のない短文・断片をフィルタリングします。

**主要関数**:
- `stripMarkdown(text)`: markdown-itでパースし、先頭のYAML frontmatterとコードブロック、リンク装飾・太字・強調・HTMLタグ等を除去して純粋テキストに変換。インラインコードはバッククォート付きで保持する。**構造保持**としてトップレベルの見出し・段落・引用・リスト・表の境界を`\n\n`、リスト項目・表セルの区切りを`\n`で保持し、LLMが要素間の文脈を正しく理解できるよう分離します（markdown-itトークンツリー走査で正規表現独自実装を回避）。
    before: ``---\ntitle: 重要\n---\n**重要**: [詳細はこちら](url) と `0.1.0` を参照。`` → after: ``重要: 詳細はこちら と `0.1.0` を参照。``
- `isWorthyForTm(text, lang)`: 日本語8文字未満・英語12文字未満・数値のみ・URL/パスのみ・英語2単語以下を除外。
- `computeTrigrams(text)`: Unicode文字単位の3-gramを生成して`Set<string>`を返す。3文字未満は空集合。`[...text]`でサロゲートペア対応。`TmxStore`（インデックス構築）と`rankTmEntries`（スコアリング）が同一ロジックを保証するため、本モジュールで一元管理。

**実装**: [`src/core/tm/tm-text-normalizer.ts`](../../src/core/tm/tm-text-normalizer.ts) ／ **詳細**: [command_tm.md](command_tm.md)

### formatTmReferences

TM検索結果（`TmMatch[]`）をプロンプト用文字列に変換。VS Code非依存のためCore層配置。

**実装**: [`src/core/tm/tm-reference-formatter.ts`](../../src/core/tm/tm-reference-formatter.ts)

### rankTmEntries

`TmxStore.findCandidatesByTrigram()` で絞り込んだ候補を精密スコアリングし、MMR (Maximal Marginal Relevance) で多様性を確保した top-k を返す純粋関数。

- **trigram Jaccard 類似度**: `options.lang` の variant テキストとクエリの trigram 集合を比較（`|A∩B|/|A∪B|`）
- **MMR 選択**: `λ × querySim(c) − (1−λ) × max_{s∈selected}(sim(s,c))` の greedy 選択。`λ=1.0` のとき純粋な類似度順と一致
- **trigramCache**: `RankOptions.trigramCache`（`TmxStore.getTrigramCache()` から渡す）が指定されると候補 variant の trigram 再計算をスキップしキャッシュから取得。省略時は `computeTrigrams(normalizeForTm(text))` にフォールバック
- 返却型 `ScoredTmEntry = TmEntry & { score: number }`

**実装**: [`src/core/tm/tm-ranker.ts`](../../src/core/tm/tm-ranker.ts)

## シーケンス図

### ステータス更新

```mermaid
sequenceDiagram
    participant Cmd as Command層
    participant Manager as StatusManager
    participant Collector as StatusCollector
    participant Tree as StatusItemTree
    participant UI as UI層

    rect rgb(200, 220, 255)
        Note over Cmd,Manager: 更新要求
        Cmd->>Manager: refreshFileStatus(filePath)
    end
    rect rgb(200, 255, 200)
        Note over Manager,Tree: 収集・格納
        Manager->>Collector: collectFileStatus(filePath)
        Collector-->>Manager: StatusItem
        Manager->>Tree: addOrUpdateFile
    end
    rect rgb(255, 240, 200)
        Note over Manager,UI: 通知
        Manager->>UI: notifyFileChanged
        UI-->>Cmd: 最新ステータス反映
    end
```

### ユニット同期ロジック

```mermaid
sequenceDiagram
    participant Src as SourceUnits
    participant Matcher as SectionMatcher
    participant Tgt as TargetUnits

    rect rgb(200, 220, 255)
        Note over Src,Tgt: 入力収集
        Src->>Matcher: source hash list
        Tgt->>Matcher: target from/hash list
    end
    rect rgb(200, 255, 200)
        Note over Matcher: マッチング処理
        Matcher->>Matcher: アンカー一致・区間マッチ
    end
    rect rgb(255, 240, 200)
        Note over Matcher,Tgt: 指示出力
        Matcher-->>Src: 新規ユニット指示
        Matcher-->>Tgt: 更新・削除指示
    end
```

## 主要コンポーネント一覧

| コンポーネント | ファイル | 責務 |
|---|---|---|
| Parser | [`src/core/markdown/parser.ts`](../../src/core/markdown/parser.ts) | Markdownをmdaitユニット配列に分割 |
| FrontMatter | [`src/core/markdown/frontmatter-translation.ts`](../../src/core/markdown/frontmatter-translation.ts) | frontmatter翻訳状態の読み書き |
| HashCalculator | [`src/core/hash/`](../../src/core/hash/) | テキスト正規化＋CRC32ハッシュ生成 |
| StatusManager | [`src/core/status/`](../../src/core/status/) | ユニット/ファイル/ディレクトリのステータス集約 |
| StatusCollectorPort | [`src/core/status/status-collector-port.ts`](../../src/core/status/status-collector-port.ts) | ステータス収集のDI境界インターフェース |
| UnitStateStore | [`src/core/unit-state/unit-state-store.ts`](../../src/core/unit-state/unit-state-store.ts) | 翻訳ユニットの状態管理（(path,order)→level/titleHash/hash/from/need）。非MD＝N=1特殊形 |
| planRenameFollow / planEntryMoves | [`src/core/unit-state/rename-plan.ts`](../../src/core/unit-state/rename-plan.ts) | ファイルの移動に訳文と `unit-state` の行を追随させる計画（ADR-260807-01） |
| UnitRegistry | [`src/core/unit-registry/`](../../src/core/unit-registry/) | ユニット内容の永続化・GC |
| DiffGenerator | [`src/core/diff/`](../../src/core/diff/) | `=`/`-`/`+`パッチ適用・unified diff生成 |
| TmxStore | [`src/core/tm/tmx-store.ts`](../../src/core/tm/tmx-store.ts) | TMX I/O・インメモリTMインデックス・trigram転置インデックス |
| SentenceSplitter | [`src/core/tm/sentence-splitter.ts`](../../src/core/tm/sentence-splitter.ts) | Intl.SegmenterによるTM文分割 |
| TmTextNormalizer | [`src/core/tm/tm-text-normalizer.ts`](../../src/core/tm/tm-text-normalizer.ts) | Markdown除去・TM価値フィルタリング |
| formatTmReferences | [`src/core/tm/tm-reference-formatter.ts`](../../src/core/tm/tm-reference-formatter.ts) | TM検索結果のプロンプト文字列変換 |
| rankTmEntries | [`src/core/tm/tm-ranker.ts`](../../src/core/tm/tm-ranker.ts) | trigram Jaccard + MMR による TM スコアリング |