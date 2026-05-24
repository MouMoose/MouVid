@echo off
echo Starting MouVid...
cd /d "%~dp0"
start "MouVid" node server.js
echo MouVid is running at http://localhost:3000
