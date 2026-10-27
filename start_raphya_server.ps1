param(
    [Parameter(Mandatory = $true)]
    [string]$ModelPath,

    [string]$ServerExe = "C:\Users\user\Downloads\llama-b10883-bin-win-cuda-12.4-x64\llama-server.exe",

    [int]$GpuLayers = 99,

    [int]$ContextSize = 8192
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
    throw "GGUF 모델 파일을 찾지 못했습니다: $ModelPath"
}

if (-not (Test-Path -LiteralPath $ServerExe -PathType Leaf)) {
    throw "llama-server 실행 파일을 찾지 못했습니다: $ServerExe"
}

$modelFile = (Resolve-Path -LiteralPath $ModelPath).Path
$serverFile = (Resolve-Path -LiteralPath $ServerExe).Path

$serverArgs = @(
    "-m", $modelFile,
    "--alias", "raphya-1",
    "--host", "127.0.0.1",
    "--port", "8080",
    "-c", $ContextSize,
    "-ngl", $GpuLayers
)

Write-Host "Raphya-1 GGUF server: http://127.0.0.1:8080" -ForegroundColor Cyan
Write-Host "Model: $modelFile"
Write-Host "GPU layers: $GpuLayers"
Write-Host "Press Ctrl+C to stop the server."

& $serverFile @serverArgs
