param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $ProjectRoot "work\runtime\naver-collector"
}

$sourceDirectory = Join-Path $ProjectRoot "naver-collector"
$environmentFile = Join-Path $ProjectRoot ".env"
$sourceWorker = Join-Path $sourceDirectory "sw.js"

if (-not (Test-Path -LiteralPath $environmentFile)) {
  throw ".env 파일을 찾지 못했습니다."
}

$tokenLine = Get-Content -LiteralPath $environmentFile -Encoding utf8 |
  Where-Object { $_ -match '^JUMPING_AGENT_TOKEN=' } |
  Select-Object -First 1

if (-not $tokenLine) {
  throw ".env에 JUMPING_AGENT_TOKEN이 없습니다."
}

$token = $tokenLine.Substring("JUMPING_AGENT_TOKEN=".Length).Trim()
if ($token -notmatch '^[A-Za-z0-9_-]{32,}$') {
  throw "JUMPING_AGENT_TOKEN 형식이 올바르지 않습니다."
}

$workerSource = [System.IO.File]::ReadAllText($sourceWorker)
if (-not $workerSource.Contains("__JUMPING_AGENT_TOKEN__")) {
  throw "sw.js에서 인증키 자리표시자를 찾지 못했습니다."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDirectory "manifest.json") -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "README.md") -Destination $OutputDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory "fast-trigger.js") -Destination $OutputDirectory -Force

$runtimeWorker = $workerSource.Replace("__JUMPING_AGENT_TOKEN__", $token)
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  (Join-Path $OutputDirectory "sw.js"),
  $runtimeWorker,
  $utf8WithoutBom
)

Write-Output "네이버 예약 수집기 설치본 생성 완료: $OutputDirectory"
