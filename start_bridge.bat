@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title VSCode Antigravity Telegram Bridge

cd /d "%~dp0"

echo ===================================================
echo     VSCode Antigravity Telegram Bridge Launcher
echo ===================================================
echo.

REM 1. 檢查 .env
if not exist ".env" (
    echo [INFO] 未偵測到 .env 設定檔。
    if exist ".env.example" (
        echo [INFO] 正在從 .env.example 建立 .env 範本...
        copy ".env.example" ".env" >nul
        echo [*] 已自動建立 .env 檔案，請先以文字編輯器打開 .env 填入您的
        echo     TELEGRAM_BOT_TOKEN 與 ALLOWED_USER_ID，填妥後再重新執行本腳本。
    ) else (
        echo [ERROR] 找不到 .env 與 .env.example，請確認專案檔案完整性。
    )
    echo.
    pause
    exit /b 1
)

REM 2. 檢查 node_modules
if not exist "node_modules\" (
    echo [INFO] 偵測到首次執行，正在自動安裝相依套件 [npm install]...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install 失敗，請確認是否已安裝 Node.js [v18+] 並擁有連網能力。
        pause
        exit /b 1
    )
    echo [OK] 套件安裝完成！
    echo.
)

REM 3. 檢查 CDP 9222 除錯埠
netstat -ano | findstr /R /C:":9222 .*LISTENING" >nul
if %errorlevel%==0 (
    echo [OK] 偵測到 VS Code 已於除錯埠 9222 運行中。
    goto run_bridge
)

REM 4. 檢查 VS Code 是否在沒有開 9222 的狀態下運行
tasklist /FI "IMAGENAME eq Code.exe" | findstr /I "Code.exe" >nul
if %errorlevel%==0 (
    echo.
    echo [*] 警告：偵測到 VS Code 正在運行，但尚未開啟 --remote-debugging-port=9222。
    echo     若未完全關閉舊有視窗，新啟動的 VS Code 將無法成功附加除錯埠。
    echo.
    echo     請先【完全關閉所有 VS Code 視窗】後，按任意鍵繼續自動重新啟動...
    pause >nul
    tasklist /FI "IMAGENAME eq Code.exe" | findstr /I "Code.exe" >nul
    if not errorlevel 1 (
        echo [ERROR] VS Code 仍在背景執行中。請完全關閉後再執行本啟動腳本。
        pause
        exit /b 1
    )
)

REM 5. 啟動 VS Code 附加除錯埠
echo [INFO] 正在以遠端除錯模式啟動 VS Code (--remote-debugging-port=9222)...

set "VSCODE_PATH="
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" (
    set "VSCODE_PATH=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
) else if exist "%ProgramFiles%\Microsoft VS Code\Code.exe" (
    set "VSCODE_PATH=%ProgramFiles%\Microsoft VS Code\Code.exe"
) else if exist "%ProgramFiles(x86)%\Microsoft VS Code\Code.exe" (
    set "VSCODE_PATH=%ProgramFiles(x86)%\Microsoft VS Code\Code.exe"
)

if defined VSCODE_PATH (
    start "" "!VSCODE_PATH!" --remote-debugging-port=9222
) else (
    echo [WARN] 未在標準路徑找到 Code.exe，嘗試透過 PATH 指令啟動...
    start "" code --remote-debugging-port=9222
)

echo [INFO] 等待 VS Code 初始化除錯伺服器 (約 5 秒)...
timeout /t 5 /nobreak >nul

:run_bridge
echo.
echo ===================================================
echo   正在啟動 Telegram Bridge 橋接服務...
echo ===================================================
echo.
node bridge.js
if errorlevel 1 (
    echo.
    echo [ERROR] Bridge 服務異常結束。請檢查上述日誌。
)
pause
