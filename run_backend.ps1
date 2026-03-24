# 从项目根启动后端：cd 到 backend 再启动，避免 ModuleNotFoundError
param(
    [int]$Port = 8000,
    [string]$Host = "0.0.0.0"
)
$backendDir = "$PSScriptRoot\backend"
Push-Location $backendDir
try {
    uvicorn app.main:app --reload --host $Host --port $Port
} finally {
    Pop-Location
}
