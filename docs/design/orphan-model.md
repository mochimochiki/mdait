# 孤立ユニットの統合モデル（isolate と独立ユニット）

原文・訳文どちらにも「相手のいない章」（孤立ユニット）は往々にして意図的に存在する（片方言語だけの補足・FAQ・ローカル告知など）。「en が多い＝訳漏れ」「ja が多い＝翻訳対象」と機械的に決めつけると、意図された独自章を削除したり、翻訳すべきでない章を翻訳してしまう。本書はこの孤立の扱いを**統合的な1つのモデル**として定義する。

> 本書は設計方針の基準文書。実装前に必ず参照する。決定は [adr.md](../adr.md) の ADR-260711-03（ADR-260706-02 を更新）。取り込みフロー全体は [command_ai-sync.md](command_ai-sync.md)、sync の孤立処理は [command_sync.md](command_sync.md)。

## 中心原理: 孤立は「ユニットの属性」ではなく「ペア（方向）との関係」

あるユニットが孤立かどうかは、**どの翻訳ペア（方向）から見るか**で変わる。ピボット（中間言語）翻訳 `ja → en → {de, fr, ...}` を考えると自明:

- 「en にはあるが ja に無い」章 → `ja→en` から見れば **訳文役割の孤立**（上流 ja に origin が無い）。だが `en→de` から見れば **正常な原文**（下流に展開すべき）。＝「グローバル版には全てあるが ja だけ無い」
- 「本当に en だけにある」章 → **原文としても訳文としても孤立**（どの言語にも対応がない、en ローカル専用）

したがって孤立は unit の boolean 属性ではなく、**役割（原文役割 / 訳文役割）ごとに独立**して判定される関係である。

## マーカー構造への読み替え

マーカーは `<!-- mdait {hash} from:{hash} need:{flag} -->`（形式は不変条件）。3枠の意味を関係モデルに読み替えると:

- **`from` の有無 = 上流起点の有無**（＝**訳文役割としての孤立**）。`from` が無い＝上流に origin なし。語彙不要・構造で自明。
- **`hash` の有無 = 下流アンカーになれるか**。hash があれば下流ペアが自動でそれを拾って `need:translate` を生成する（＝下流へ伝播する）。
- 1マーカーが `hash`（下流用アンカー）と `from`（上流リンク）を**同時に持てる**ため、ピボットの「en は ja の訳文でありつつ他言語の原文」は既存構造で破綻しない（`ja→en→de` チェーンは実装・テスト済み）。

**「訳文としてのみ孤立（ja には無いが下流には流す）」は素の `<!-- mdait {enHash} -->`（from なし・need なし）で構造的に表現される。** 原文役割の孤立（＝下流に相手を作らない）だけが明示語彙 `need:isolate` を必要とする — 原文側は「hash のみ」が翻訳待ちの正常状態であり、そこに孤立の意味を載せられないため。

### 役割の真理値表（from × isolate）

| from | isolate | 役割 | 例 | マーカー |
|:---:|:---:|------|------|------|
| なし | OFF | 訳文としてのみ孤立（上流なし・下流あり） | グローバル版にはあるが ja に無い en 章 | `<!-- mdait {hash} -->` |
| 有/無 | **ON** | 原文としての孤立（下流に出さない） | ja 独自の補足章 | `<!-- mdait {hash} [from:x] need:isolate -->` |
| なし | ON | 両方孤立（真のローカル） | 本当に en だけの章 | `<!-- mdait {hash} need:isolate -->` |
| あり | OFF | 通常の対訳 | — | `<!-- mdait {hash} from:x -->` |

必要な新情報は「下流伝播を止めるか」の1ビット（＝isolate）だけ。上流孤立は `from` 無しで既に表せている。

## need 語彙（最終形）

| need | from | 意味 | trans対象 | TM commit対象 |
|---|---|---|:---:|:---:|
| なし | あり | 通常の対訳（同期済み） | ✕ | ✅ |
| なし | なし | **独立ユニット**（訳文役割の孤立。上流なし・下流へは伝播する起点） | ✕ | ✕（noFrom） |
| `translate` | あり | 未翻訳 | ✅ | ✕ |
| `revise@{h}` | あり | 原文改訂により再翻訳待ち | ✅ | ✕ |
| `review` | あり/なし | 人間ゲート（adopt採用・穴あき一次受け） | ✕ | ✕ |
| `isolate` | あり/なし | **保持＋下流伝播停止**（原文役割の孤立／真のローカル） | ✕ | ✕ |
| `verify-deletion` | あり/なし | 原文削除に伴う削除確認 | ✕ | ✕ |

`need:keep` と `need:backfill` は**廃止**（後述のマイグレーション参照）。

## 独立ユニット（target 側パススルー保護）

**パース時点でファイルに永続化されたマーカー**を持つ target ユニットのうち、**from なし かつ `need !== "verify-deletion"`** のものを**独立ユニット**とする（素 hash / from なし `need:isolate` / need:review の一次受け保留 / その他の異常系も安全側で保持）。

独立ユニットは SectionMatcher の対応付け対象外・孤立処理（orphanTargetPolicy）の対象外で、無条件にパススルー保持される（`kept` として集計・不変・冪等）。

**from 付き `need:isolate` は独立ユニットにしない**: isolate は「下流に出さない」であって上流リンクの切断ではないため、上流ペアは Phase 1（from 一致）で維持され、need の凍結（後述）で伝播だけが止まる。原文消失で孤立した場合は分岐2の手前で isolate 自体が保持を保証する（policy 対象外）。

実装上の要点: `sync_CoreProc` は `ensureMdaitMarkerHash` でマーカーなしユニットにメモリ上の素 hash マーカーを合成するため、「ファイルに書かれていた素 hash（＝ユーザーの意図的な独立宣言）」と区別する必要がある。判定 Set（`independentTargets`）は `normalizeLegacyNeeds` 適用後・ensure **前**に構築し、`SectionMatcher.match` と `createSyncedTargets` に渡す。

## 孤立ターゲットの三分岐

match 結果の `{source: null, target}` ペア（対応する原文が無い target）は3通りに分岐する:

| # | 条件 | 処理 | 集計 |
|---|------|------|------|
| 1 | 独立ユニット（`independentTargets` に含まれる）または `need:isolate` | パススルー保持 | `kept` |
| 2 | `from` が残っている（dangling）＝管理済みで原文を失った | `orphanTargetPolicy`: `delete`=削除 / `verify`=`need:verify-deletion` 付与 | `orphanVerified`（verify時） |
| 3 | `from` なし かつ独立ユニットでない（＝マーカーなしで書かれた管理外コンテンツ） | **穴あき一次受け**: `setNeed("review")`（from は付けない） | `orphanReviewed` |

分岐3の根拠は「**決めつけず人間へ**」: マーカーなしの訳文側コンテンツが「意図的な独自章」か「訳漏れの残骸」か「不要物」かは、ドキュメントの意図を知る人間にしか判断できない。sync は削除も翻訳も決めつけず `need:review` で保護し、人間が「素 hash 化（独自章宣言）/ `need:isolate` / 削除」を選ぶ。adopt・定常 sync 共通。次回 sync では「永続化された from なし need:review」として独立ユニット（分岐1）になるため冪等。

旧モデルとの挙動差: 旧仕様ではマーカーなし孤立 target にも policy（デフォルト `delete`）が適用され黙って削除されていた。新モデルでは need:review 保護に変わる（安全側）。policy が適用されるのは分岐2（from dangling）のみ。

## isolate の伝播停止セマンティクス（source 側）

`need:isolate` の source ユニットは「下流に翻訳需要を流さない」:

- **syncNew**: target 生成から除外される（target ファイルに出力されない）
- **match**: Phase 1（from 一致）でのみマッチ可。Phase 2（順序ベース推定）の対象外。Phase 1 でマッチしなかった isolate source は `{source, target: null}` として hash 更新のみ行う
- **空 target 非生成**: 未マッチの isolate source に対して `need:translate` の空 target ユニットを生成しない
- **ペア済みは凍結**: ペアの**どちらか一方**が isolate なら、`syncMarkerPair` は `suppressNeed` オプションで hash と from のみ更新し、`need:translate` / `need:revise` を一切付与しない（既存 need もそのまま）。target 側 isolate（ピボット中間ファイルの「下流に出さない」宣言）では、これが revise による isolate 上書きも防ぐ

**凍結ペアの注意点**: リンクは維持されるが新しい翻訳需要が流れないため、原文を改訂し続けると訳文が静かにドリフトする。isolate を解除（need を外す）すれば次回 sync が通常の revise 検出に復帰する。ドリフトした凍結ペアの TM 汚染は `sourcePending` スキップ（後述）で防ぐ。

## keep / backfill の廃止とマイグレーション

**廃止理由**: 現実的な翻訳ワークフローで必要になる場面が非常に限定的だった。

- `keep`（保持＋伝播は hash 任せ）は「from なし・need なしの素 hash」＝独立ユニットと意味的に等価であり、専用語彙が不要（keep は常に from なしだった）
- `backfill`（訳文孤立を原文側へ逆翻訳で埋め戻す）は、原文ファイルへの書き込みという非対称な危険を伴う割に用途が限定的で、フローごと削除

**マイグレーション**（`normalizeLegacyNeeds`。sync / syncNew のパース直後に source/target 両方へ適用。決定的・冪等・AI 不使用）:

| レガシー need | 変換 | 意味 |
|---|---|---|
| `keep` | need 除去（素 hash 化） | 独立ユニットとして意味的に等価な形へ |
| `backfill` | `need:review` | source 側プレースホルダを人間ゲートへ。人間が「原文として整備して review 解除」か「ユニット削除」を判断（手順は [adopt.md](../guide/ja/adopt.md)） |

設定ファイルのレガシー値 `orphanTargetPolicy: "keep"` / `"backfill"` は警告ログを出して `"verify"` として解釈する（安全側）。型は `"delete" | "verify"` に縮小（スキーマ enum も同様）。

## TM 整合（包括除外・sourcePending）

- **`isTmCommitTarget` は包括方式**: 「from あり ∧ need が null」のみ commit 対象。列挙式除外で未知 need を素通しする穴（ADR-260704-07 の既知の潜在バグ）を構造的に塞いだ
- **`TmSkipReason`** = `noFrom | needTranslate | needRevise | needReview | needIsolate | needOther | sourcePending`。translate / revise@ / review / isolate は明示分類、その他の need は `needOther`
- **`sourcePending`**: ペア解決時に **source 側ユニットの marker に need が付いている場合はスキップ**する（例: isolate 凍結ペア、レガシー backfill→review プレースホルダ）。ドリフトした凍結ペアや同一内容プレースホルダの TM 汚染を防ぐ。`classifyTmSkipReason` 自体は target 単体の純関数のままで、sourcePending は commit 側で付与する

独立ユニットは from を持たないため `noFrom` で自然に除外される。

## 不変条件との整合・限界

- **マーカー形式は不変**。新概念は need 語彙のみで表す。parser は `need:([\w@-]+)` なので `isolate` はそのままパース可能。
- **独立ユニットは AI アラインの修正提案対象にも出さない**: matchResult 上のパススルーペア（`{source: null, target}`）は align の unmatchedTarget 候補から除外する。
- **per-pair 粒度の限界**: マーカーは per-file・single-`from`。「en→de には出すが en→fr には出さない」を1マーカーで表すのは無理。**v1 は「全下流に対して伝播ON/OFF」の粒度に割り切る**。方向別抑制が要るなら `.mdait` の unit-state に方向キーで持つ将来拡張。
- **primary ancestor との接続**: TM は翻訳方向相対でなく primary origin を追う。孤立ユニットの primary は「自分自身」とみなす（上流が無いため）。
- **AI 明示起動（ADR-260705-01）**: 穴あきの一次受け（need:review 付与）・マイグレーション・パススルーはすべて決定的・AI 不使用・冪等。分類の**提案**のみ AI（明示起動のレビュー内）が行い、確定はしない。

## 将来増分

| 増分 | 概要 |
|------|------|
| 孤立ロール宣言 UI | CodeLens/コマンドで「この章を孤立に（訳文孤立=素hash / 原文孤立=isolate / 両方）」を宣言 |
| AIレビューでの孤立分類提案 | 一次受け need:review のユニットに対し「独自章らしい / 訳漏れらしい」の分類を AI が提案（確定はしない） |
| レポート＝判断サーフェス | リンク付き md を対話化し、人間の選択（素hash化 / isolate / 削除 / 翻訳 / 承認）→決定的後処理のマーカー変異にマッピング |
