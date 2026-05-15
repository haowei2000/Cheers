# Start uvicorn from the backend directory to avoid ModuleNotFoundError during reload.
# Usage: .\run_dev.ps1 or .\run_dev.ps1 -Port 8001 -Host 127.0.0.1
param(
    [int]$Port = 8000,
    [string]$Host = "0.0.0.0"
)
Set-Location $PSScriptRoot
uvicorn app.main:app --reload --host $Host --port $Port
