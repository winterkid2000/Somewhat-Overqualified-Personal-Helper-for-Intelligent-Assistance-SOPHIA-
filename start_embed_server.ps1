param(
    [string]$ModelPath = "C:\Users\user\Desktop\sophia\bge-m3-Q4_0.gguf",

    [string]$ServerExe = "C:\Users\user\Downloads\llama-b10883-bin-win-cuda-12.4-x64\llama-server.exe",

    [int]$Port = 8081
)

$ErrorActionPreference = "Stop"

& $ServerExe -m $ModelPath --embedding --host 127.0.0.1 --port $Port -c 8192 -ub 2048 -ngl 99
#powershell -ExecutionPolicy Bypass -File .\start_embed_server.ps1