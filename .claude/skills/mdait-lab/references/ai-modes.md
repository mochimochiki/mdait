# AI の相手を選ぶ（shim の5つのモード）

mdait の `ai.provider: "openai"` は `ai.openai.baseURL` の行き先を差し替えられる。`lab up` は
OpenAI 互換のローカルサーバー（`scripts/lab/ai/`）を空きポートで立て、ワークスペースの設定をそこへ向ける。
**裏で誰が答えるかを `--ai` で選ぶ。** どのモードでも mdait 側は本物の HTTP を喋るので、プロバイダ層
（リトライ・タイムアウト・`ai-stats.log` への記録）まで本物が走る。

| モード | 誰が答えるか | 費用 | 決定的か | 主な用途 |
|---|---|---|---|---|
| `echo` | shim 自身が機械的に作る | 0 | はい | 機構の確認。既定。**まずこれを使う** |
| `live` | あなた（ファイルの郵便受け） | 0 | いいえ | 送っているものを実際に見る。壊れた答えを手で注入する |
| `script` | 台本を順に返す | 0 | はい | 429・500・遅延・途中で切れた JSON への耐性 |
| `replay` | 録音の再生 | 0 | はい | 回帰。要求が録音と1文字でも違えば 409 で止まる |
| `agent` | `claude` コマンドを翻訳役として起動 | **かかる** | いいえ | 指示文の改稿の比較。訳質の確認 |
| `none` | 立てない（設定に触らない） | — | — | 実プロバイダを使う（desktop ホスト） |

## echo — まずこれ

決定的な訳文を返す。`--delay <ミリ秒>` で遅らせられる（UI の「翻訳中」を撮るため）。

- `__CODE_BLOCK_PLACEHOLDER_n__` という目印は**必ずそのまま返す**。落とすと本文が消える。
- 同じ入力なら必ず同じ出力。時刻も乱数も混ぜない。
- 訳質は見られない。見たいなら `agent` を使う。

## live — 実物を見る、壊れた答えを注入する

`digest-NNN.md` は前回からの差分だけを見せるので、何往復しても読み手の作業記憶が尽きない。
全文は `req-NNN.json` にある。

```bash
lab up --ai live
lab run mdait.trans "<ファイル>" &     # 別で走らせておく
lab ai wait                            # 要求が来るまで戻らない
lab ai digest                          # 何を送ってきたかを読む
lab ai reply --translation "訳文をここに"
```

`--translation` は `{"translation": "..."}` に包んでから渡す。手で JSON を書くと引用符の入れ子で
ほぼ必ず間違えるので、翻訳を返すときは必ずこれを使う。

**`live` は指示文の比較に使えない。** 答える側（＝あなた）が作業場の事情を知っているので、
指示文が悪くても補って答えてしまう。`live` は観察と注入のためのもの。

**待ち時間はそのまま HTTP のタイムアウトに乗る。** 考えている間に mdait が諦めないよう、
`ai.openai.timeoutSec` は長めにしておく（`lab up` は既定で長めに設定する）。

## script — わざと壊す

`scripts/lab/ai/scenarios/nasty.jsonl` に意地の悪い場面が並べてある。`res` の鍵で振る舞いを作る:
`delay`（秒だけ黙る）、`http_status`（429 / 500 を返す）、`finish_reason`（`length` で途中打ち切り）、
`raw_chunks`（壊れた SSE を検査せず流す）。

```bash
lab up --ai script --script scripts/lab/ai/scenarios/nasty.jsonl
```

台本を使い切ると 409 で止まる。黙って先頭へ戻らない。

## replay — 回帰を守る

```bash
lab regress        # = npm run test:byok:e2e。録音の12往復を再生。LLM 0回
```

**これが落ちたら、指示文の組み立てが変わったということ。** 意図した変更なら録り直す。

```bash
lab prompt --dir en/child --record scripts/lab/ai/recordings/trans-en-child.jsonl
lab regress        # 録り直したもので通ることを確かめる
```

意図しない変更なら、録音との差分がそのまま原因を指している。`--record` を別ファイルに取って
`req` の中身を突き合わせる。**黙って録音を上書きしない** — 何が変わったのかを先に説明できるようにする。

## agent — 指示文の改稿を比べる

`claude -p` を1回起こして答えさせる。無人で並列に走る。

**この翻訳役は mdait を知らない**（実測で「mdait とは何か」に `I DO NOT KNOW.` と答えた）。道具を持たず、
作業場所は空のディレクトリ、`--safe-mode` で `CLAUDE.md` も読まない。指示文は `--system-prompt` で
丸ごと置き換わる。だから**指示文の出来がそのまま結果に出る**。

```bash
lab prompt --dir en/child --record /tmp/before.jsonl
# mdait.json の prompts で指示文を差し替えてから、--record 先を変えて同じことをする
```

比べていることの中身は3つに縛られる。この枠を外して結論を書かない。

- 測っているのは「その指示文 × Claude」であって指示文そのものではない。本番で別のモデルを使うなら、
  その組み合わせで測り直すことになる
- 温度や種を指定する口が無い。1回の結果で決めない
- 1依頼あたり4〜5秒、実費がかかる。対象は1〜3ファイルに絞る

## 秘密の扱い

`--record` に秘密は残らない（`Authorization` の値は伏せ字になる）。ただし要求の全文は残るので、
原稿そのものを見せたくない場合は録音を配らない。
