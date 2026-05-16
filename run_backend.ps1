# Start the backend from the project root by entering backend first to avoid ModuleNotFoundError.
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
