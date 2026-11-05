@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js 22.16 or newer is required.
 echo Install from https://nodejs.org/en/download
 pause
 exit /b 1
)
echo OSMANX APP FACTORY R0.8
echo Open http://127.0.0.1:4173 in your browser.
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:4173/"
node server.mjs
if errorlevel 1 (
 echo Startup failed. Read the error above.
 pause
)
