param([int]$Port = 8767)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Portは1024〜65535で指定してください。' }
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Write-Host "演出ラボ: http://127.0.0.1:$Port/admin/effects-lab/"
Write-Host 'この画面を開いたまま使ってください。終了は Ctrl+C。'
# 既存の編集用サーバーとは別ポート。LANには公開しない。
python -m http.server $Port --bind 127.0.0.1 --directory $repoRoot
