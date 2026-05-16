@echo off
chcp 65001 >nul
echo ========================================
echo    SkillHub startup script
echo ========================================
echo.

REM Resolve the script directory
set SCRIPT_DIR=%~dp0
set SKILLHUB_ROOT=%SCRIPT_DIR%..
set BACKEND_ROOT=%SKILLHUB_ROOT%\backend
set FRONTEND_ROOT=%SKILLHUB_ROOT%\frontend
set VENV_PATH=%BACKEND_ROOT%\.venv

REM Prefer the project virtual environment, creating it on first run
if not exist "%VENV_PATH%\Scripts\activate.bat" (
    echo [Info] First run detected. Creating virtual environment...
    cd /d %BACKEND_ROOT%
    call uv venv
    call uv pip install -r requirements.txt
)

REM Start backend
echo [1/2] Starting backend service (port 8002)...
start "SkillHub-Backend" cmd /k "cd /d %BACKEND_ROOT% && .venv\Scripts\activate.bat && uvicorn app.main:app --reload --host 0.0.0.0 --port 8002"

timeout /t 3 /nobreak >nul

REM Start frontend
echo [2/2] Starting frontend service...
start "SkillHub-Frontend" cmd /k "cd /d %FRONTEND_ROOT% && npm run dev"

echo.
echo ========================================
echo    Startup complete!
echo    Backend: http://localhost:8002
echo    Frontend: http://localhost:5173 (or 5174)
echo    API:  http://localhost:8002/docs
echo ========================================
pause
