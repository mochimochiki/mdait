#!/usr/bin/env python3
"""「片方がファイルを改名し、片方が同じファイルの中身を直す」を**本物の git** で合流させる。

merge-extra.mjs の台は改名の検出（rename detection）をしないので、その分を確かめる。
embedded（マーカーが .md にある）と external（状態が .mdait/unit-state にある）を
それぞれ別のリポジトリで試す。
"""
import os
import shutil
import subprocess

ROOT = "/tmp/mdait-agentA/rename-git"


def sh(cmd, cwd, check=True):
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"{cmd}\n{r.stdout}{r.stderr}")
    return r


ROWS = [
    ("50000000", "1", "11111111", "aaaa1111", "aaaa1111", ""),
    ("50001024", "2", "22222222", "bbbb2222", "bbbb2222", ""),
    ("50002048", "2", "33333333", "cccc3333", "cccc3333", ""),
]
TITLES = ["# 記事2", "## a2第1章", "## a2第2章"]


# 行はパスではなくファイルIDで自分を名乗る（ADR-260908-03）。ID とパスの対応を持つのは
# ブロックの見出し1行だけなので、改名でこの台が書き換えるのもその1行だけになる。
FILE_ID = "0123456789ab"


def state(path, rows):
    out = [
        "# mdait unit-state — 翻訳ユニットの状態管理",
        "# id\tkind\tseat\tlevel\ttitleHash\thash\tfrom\tneed",
        "",
        f"# {FILE_ID} {path}",
        "",
    ]
    body = []
    for seat, level, th, h, frm, need in rows:
        body.append(f"# u{seat}\n{FILE_ID}\tunit\t{seat}\t{level}\t{th}\t{h}\t{frm}\t{need}")
    out.append("\n\n".join(body))
    out += ["", f"# {FILE_ID} [unseated]", ""]
    return "\n".join(out) + "\n"


def md(rows, embedded):
    parts = []
    for (seat, level, th, h, frm, need), title in zip(rows, TITLES):
        marker = f"<!-- mdait {h}" + (f" from:{frm}" if frm else "") + (f" need:{need}" if need else "") + " -->"
        text = f"{title}\n\n{title.strip('# ')} の本文"
        parts.append(f"{marker}\n{text}" if embedded else text)
    return "\n\n".join(parts) + "\n"


def run(mode, union=True):
    d = os.path.join(ROOT, mode + ("-union" if union else "-plain"))
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(os.path.join(d, "content/en"))
    os.makedirs(os.path.join(d, ".mdait"))
    sh("git init -q . && git config user.email a@b && git config user.name a", d)

    embedded = mode == "embedded"
    open(f"{d}/content/en/a2.md", "w").write(md(ROWS, embedded))
    if not embedded:
        open(f"{d}/.mdait/unit-state", "w").write(state("content/en/a2.md", ROWS))
        if union:
            open(f"{d}/.mdait/.gitattributes", "w").write("unit-state merge=union\nunit-registry merge=union\n")
    sh("git add -A && git commit -qm base", d)

    # 枝1: 訳文ごと改名する（原文だけ改名したときに製品がやること）
    sh("git checkout -qb rename", d)
    sh("git mv content/en/a2.md content/en/a2-renamed.md", d)
    if not embedded:
        open(f"{d}/.mdait/unit-state", "w").write(state("content/en/a2-renamed.md", ROWS))
    sh("git add -A && git commit -qm rename", d)

    # 枝2: 同じファイルの第2章を改訂する
    sh("git checkout -q master && git checkout -qb edit", d)
    rows2 = list(ROWS)
    rows2[2] = ("50002048", "2", "33333333", "dddd4444", "cccc3333", "revise@dddd4444")
    open(f"{d}/content/en/a2.md", "w").write(md(rows2, embedded))
    if not embedded:
        open(f"{d}/.mdait/unit-state", "w").write(state("content/en/a2.md", rows2))
    sh("git add -A && git commit -qm edit", d)

    r = sh("git merge rename -m m", d, check=False)
    conflicted = r.returncode != 0
    print(f"=== {mode} / {'merge=union' if union else '素の3方向マージ'} ===")
    print("競合:", "あり" if conflicted else "なし")
    print("残ったファイル:", sorted(os.listdir(f"{d}/content/en")))
    survived = None
    for f in os.listdir(f"{d}/content/en"):
        text = open(f"{d}/content/en/{f}").read()
        if "dddd4444" in text or "（直した）" in text:
            survived = f
    if embedded:
        print("改訂した状態(dddd4444)が .md に残ったか:", survived is not None)
    else:
        st = open(f"{d}/.mdait/unit-state").read()
        heads = [l for l in st.splitlines() if l.startswith("# ") and ".md" in l]
        print("改訂した状態(dddd4444)が unit-state に残ったか:", "revise@dddd4444" in st)
        print("見出しのパス:", heads)
        print("生きているパスの行が revise@ を持つか:", check_live_row(d))
        print("--- unit-state ---")
        print(st)
    print()


def check_live_row(d):
    """製品の読み取りを通して、**いま実在するパス**の行が revise@ を持つかを見る。

    合流のあとのファイルは人が読んでも判断しづらいので、ストアに読ませて答えさせる。
    """
    repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
    script = f"""
const {{ UnitStateStore }} = require({repo!r} + "/out/core/unit-state/unit-state-store.js");
const fs = require("node:fs");
const store = UnitStateStore.getInstance();
store.load({d!r} + "/.mdait");
const live = fs.readdirSync({d!r} + "/content/en").map((f) => "content/en/" + f);
const found = live.flatMap((p) => store.getEntriesByPath(p).map((e) => `${{p}} ${{e.seat}} ${{e.hash}} ${{e.need}}`));
console.log(JSON.stringify(found.filter((l) => l.includes("revise@"))));
"""
    probe = os.path.join(d, "probe.cjs")
    open(probe, "w").write(script)
    r = sh(f"node {probe}", d, check=False)
    os.remove(probe)
    return (r.stdout or r.stderr).strip()


os.makedirs(ROOT, exist_ok=True)
run("embedded", True)
run("external", True)
run("external", False)
