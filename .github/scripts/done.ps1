# done.ps1 - タスクチケットを .tasks/do から .tasks/done に移動する
# ガード: TODO/品質要件の未チェック項目、レビューの🔴🟠未チェック項目があればブロック

param(
    [Parameter(Mandatory=$true)]
    [string]$TicketName
)

$src = ".tasks/do/$TicketName"
$dst = ".tasks/done/$TicketName"

if (-not (Test-Path "$src.md")) {
    Write-Error "Ticket not found: $src.md"
    exit 1
}

# チケット内容を読み込み、未完了チェックボックスを検証
$content = Get-Content "$src.md" -Raw -Encoding UTF8
$lines = Get-Content "$src.md" -Encoding UTF8

$currentSection = ""
$errors = @()

foreach ($line in $lines) {
    # セクション見出しを追跡
    if ($line -match "^## (.+)") {
        $currentSection = $Matches[1].Trim()
    }

    # 未チェック項目の検出
    if ($line -match "^- \[ \]") {
        switch ($currentSection) {
            "TODO" {
                $errors += "TODO未完了: $line"
            }
            { $_ -like "*品質要件*" } {
                $errors += "品質要件未完了: $line"
            }
            { $_ -like "*レビュー*" } {
                # 🔴🟠のみブロック、🟡🟢はスキップ
                if ($line -match "🔴|🟠") {
                    $errors += "レビュー重大/優先未対応: $line"
                }
            }
        }
    }
}

if ($errors.Count -gt 0) {
    Write-Error "=== チケット移動をブロックしました ==="
    foreach ($err in $errors) {
        Write-Error "  $err"
    }
    Write-Error "未完了項目を解消してから再実行してください。"
    exit 1
}

Move-Item "$src.md" "$dst.md" -Force
Write-Host "Moved: $src.md -> $dst.md"
Write-Host "Done: $TicketName is now in .tasks/done/"
