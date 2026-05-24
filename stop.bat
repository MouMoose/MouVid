@echo off
echo Stopping MouVid...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr /r ":3000 "') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo MouVid stopped.
