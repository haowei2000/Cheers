@echo off
chcp 65001 >nul
echo ========================================
echo    SkillHub 启动脚本
echo ========================================
echo.

REM 获取脚本所在目录
set SCRIPT_DIR=%~dp0
set SKILLHUB_ROOT=%SCRIPT_DIR%..
set BACKEND_ROOT=%SKILLHUB_ROOT%\backend
set FRONTEND_ROOT=%SKILLHUB_ROOT%\frontend
set VENV_PATH=%BACKEND_ROOT%\.venv

REM 优先使用项目自己的虚拟环境，如果不存在则创建
if not exist "%VENV_PATH%\Scripts\activate.bat" (
    echo [提示] 首次运行，正在创建虚拟环境...
    cd /d %BACKEND_ROOT%
    call uv venv
    call uv pip install -r requirements.txt
)

REM 启动后端
echo [1/2] 启动后端服务 (端口 8002)...
start "SkillHub-Backend" cmd /k "cd /d %BACKEND_ROOT% && .venv\Scripts\activate.bat && uvicorn app.main:app --reload --host 0.0.0.0 --port 8002"

timeout /t 3 /nobreak >nul

REM 启动前端
echo [2/2] 启动前端服务...
start "SkillHub-Frontend" cmd /k "cd /d %FRONTEND_ROOT% && npm run dev"

echo.
echo ========================================
echo    启动完成!
echo    后端: http://localhost:8002
echo    前端: http://localhost:5173 (或 5174)
echo    API:  http://localhost:8002/docs
echo ========================================
pause
