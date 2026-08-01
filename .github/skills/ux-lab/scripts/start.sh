#!/usr/bin/env bash
# mdait UX Lab: code-server の起動。詳細は ../SKILL.md 参照。
set -euo pipefail

WORKDIR="${MDAIT_UXLAB_DIR:-/tmp/mdait-uxlab}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
PORT="${MDAIT_UXLAB_PORT:-8099}"
WORKSPACE="${1:-$REPO_ROOT/src/test/unit/workspace}"

# 自分の WORKDIR の code-server だけを止める（他インスタンスを巻き込まない）
pkill -f "$WORKDIR/node_modules/code-server/out/node/entry.js" 2>/dev/null || true
sleep 1

nohup node "$WORKDIR/node_modules/code-server/out/node/entry.js" \
  --auth none --bind-addr "127.0.0.1:$PORT" \
  --extensions-dir "$WORKDIR/cs-ext" --user-data-dir "$WORKDIR/cs-data" \
  --disable-telemetry --disable-update-check \
  "$WORKSPACE" > "$WORKDIR/cs.log" 2>&1 &

code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --noproxy '*' "http://127.0.0.1:$PORT/" || true)
  if [ "$code" = "302" ] || [ "$code" = "200" ]; then break; fi
  sleep 1
done

if [ "$code" = "302" ] || [ "$code" = "200" ]; then
  echo "code-server 起動: http://127.0.0.1:$PORT/?folder=$WORKSPACE"
else
  echo "起動失敗 (HTTP $code)。ログ: $WORKDIR/cs.log" >&2
  exit 1
fi
