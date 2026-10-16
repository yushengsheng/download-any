@echo off
chcp 65001 >nul
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20 或更新的 LTS 版本：https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0start.js" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
