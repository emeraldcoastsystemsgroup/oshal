@echo off
REM =============================================================================
REM OSHAL Full Rebuild & Restart (Windows)
REM =============================================================================
REM Rebuilds all images from source and restarts every container.
REM Run from the project root: scripts\full-rebuild.bat
REM =============================================================================

setlocal
cd /d "%~dp0.."

echo.
echo   ==========================================
echo   OSHAL Full Rebuild ^& Restart
echo   ==========================================
echo.

REM ── Step 1: Build images ──────────────────────────────────────────
echo [1/5] Building bot image (oshal-bot:latest)...
docker build -t oshal-bot:latest . || goto :error
echo       Done.

echo [2/5] Building api-server image...
docker compose -f docker-compose.yml build api-server || goto :error
echo       Done.

REM ── Step 2: Stop everything ───────────────────────────────────────
echo [3/5] Stopping all containers...
docker compose -f docker-compose.swarm-local.yml down 2>nul
docker compose -f docker-compose.yml stop api-server 2>nul
echo       Done.

REM ── Step 3: Drop stale views (prevents schema bootstrap errors) ──
echo [4/5] Dropping stale DB views for clean schema bootstrap...
docker compose -f docker-compose.swarm-local.yml up -d oshal-db oshal-redis oshal-chromadb
timeout /t 10 /nobreak >nul
docker exec oshal-swarm-db psql -U oshal -d oshal -c "DROP VIEW IF EXISTS ticket_cost_rollup_with_children CASCADE; DROP VIEW IF EXISTS ticket_cost_rollup CASCADE; DROP VIEW IF EXISTS ticket_agent_summary CASCADE;" 2>nul
echo       Done.

REM ── Step 4: Start everything ──────────────────────────────────────
echo [5/5] Starting all containers...
docker compose -f docker-compose.swarm-local.yml up -d
docker compose -f docker-compose.yml up -d api-server
echo       Done.

echo.
echo   ==========================================
echo   Rebuild complete. Waiting for health...
echo   ==========================================
timeout /t 20 /nobreak >nul

REM ── Health check ──────────────────────────────────────────────────
curl -s http://localhost:3456/api/health >nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo   [OK] API Server healthy on :3456
) else (
    echo   [WARN] API Server not responding yet on :3456
)

docker ps --format "table {{.Names}}\t{{.Status}}" | findstr /i "healthy" | find /c "healthy" >nul 2>&1
for /f %%i in ('docker ps --format "{{.Names}}" ^| find /c /v ""') do echo   [OK] %%i containers running

echo.
echo   To start the local agent over VPN:
echo     scripts\start-local-agent.bat
echo.

goto :eof

:error
echo.
echo   [ERROR] Build failed. Check output above.
pause
exit /b 1
