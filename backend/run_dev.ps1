# 在 backend 目录下启动 uvicorn，避免 reload 时 ModuleNotFoundError
# 用法: .\run_dev.ps1  或  .\run_dev.ps1 -Port 8001 -Host 127.0.0.1
param(
    [int]$Port = 8000,
    [string]$Host = "0.0.0.0"
)
Set-Location $PSScriptRoot
uvicorn app.main:app --reload --host $Host --port $Port
