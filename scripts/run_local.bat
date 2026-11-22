@echo off
cd /d "%~dp0\.."
echo Open http://localhost:4173 in Chrome or Edge
py -3 -m http.server 4173
