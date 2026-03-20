# done.ps1 - タスクチケットを tasks/do から tasks/done に移動する

param(
    [Parameter(Mandatory=$true)]
    [string]$TicketName
)

$src = "tasks/do/$TicketName"
$dst = "tasks/done/$TicketName"

if (-not (Test-Path "$src.md")) {
    Write-Error "Ticket not found: $src.md"
    exit 1
}

Move-Item "$src.md" "$dst.md" -Force
Write-Host "Moved: $src.md -> $dst.md"

if (Test-Path "$src.review.md") {
    Move-Item "$src.review.md" "$dst.review.md" -Force
    Write-Host "Moved: $src.review.md -> $dst.review.md"
}

Write-Host "Done: $TicketName is now in tasks/done/"
