@echo off
rem Serves the dashboard on http://localhost:8000 and opens it in Microsoft Edge.
rem (Web Serial needs Chrome or Edge; keep this window open while using the dashboard.)
cd /d "%~dp0dashboard"
start "" msedge http://localhost:8000
python -m http.server 8000 --bind 127.0.0.1
