@echo off
REM =============================================================================
REM OSHAL Local Agent — Windows batch launcher
REM =============================================================================
REM Connects to the swarm via Headscale VPN, then starts the local agent.
REM
REM Prerequisites:
REM   - Tailscale installed (https://tailscale.com/download/windows)
REM   - Docker swarm running (docker compose -f docker-compose.swarm-local.yml up -d)
REM   - Headscale running (cd infra/headscale && docker compose up -d)
REM =============================================================================

setlocal enabledelayedexpansion

echo.
echo   ==========================================
echo   OSHAL Local Agent Launcher (Windows)
echo   ==========================================
echo.

REM ── Step 1: Check Tailscale ───────────────────────────────────────────────
where tailscale >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Tailscale is not installed.
    echo         Download from: https://tailscale.com/download/windows
    echo         Or run: winget install Tailscale.Tailscale
    echo.
    echo   Installing via winget...
    winget install Tailscale.Tailscale --accept-package-agreements --accept-source-agreements
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install Tailscale. Install manually and re-run.
        pause
        exit /b 1
    )
    echo [OK] Tailscale installed. You may need to restart this script.
)

REM ── Step 2: Connect to Headscale VPN ──────────────────────────────────────
REM The auth key is a live credential and never lives in the repo. Supply it via
REM the environment, or drop it in %USERPROFILE%\.oshal-headscale-authkey (one line).
REM Mint one on the swarm host with the enrollment helper (single-use, ephemeral,
REM pre-tagged tag:worker so the hardened ACL scopes this machine immediately):
REM     bash scripts/headscale-enroll-worker.sh
if "%HEADSCALE_URL%"=="" set HEADSCALE_URL=http://localhost:8085

if "%HEADSCALE_AUTHKEY%"=="" (
    if exist "%USERPROFILE%\.oshal-headscale-authkey" (
        set /p HEADSCALE_AUTHKEY=<"%USERPROFILE%\.oshal-headscale-authkey"
    )
)
if "%HEADSCALE_AUTHKEY%"=="" (
    echo [ERROR] No Headscale auth key.
    echo         Mint one on the swarm host:  bash scripts/headscale-enroll-worker.sh
    echo         then either:  set HEADSCALE_AUTHKEY=^<the key^>
    echo         or write it as the single line of %USERPROFILE%\.oshal-headscale-authkey
    pause
    exit /b 1
)

echo [VPN] Connecting to Headscale at %HEADSCALE_URL% ...
tailscale up --login-server %HEADSCALE_URL% --authkey %HEADSCALE_AUTHKEY% --accept-dns=false
if %ERRORLEVEL% neq 0 (
    echo [WARN] Tailscale connect returned non-zero. Checking status...
)

REM Wait for Tailscale to get an IP
timeout /t 5 /nobreak >nul
for /f "tokens=*" %%i in ('tailscale ip -4 2^>nul') do set TAILSCALE_IP=%%i
echo [VPN] Tailscale IP: %TAILSCALE_IP%

REM Get the headscale server's Tailscale IP (first peer)
for /f "tokens=1" %%i in ('tailscale status 2^>nul ^| findstr /v "^#" ^| findstr /v "%TAILSCALE_IP%"') do (
    set SWARM_VPN_IP=%%i
    goto :got_swarm_ip
)
:got_swarm_ip
if not defined SWARM_VPN_IP (
    echo [WARN] Could not detect swarm VPN IP. Using localhost fallback.
    set SWARM_VPN_IP=localhost
)
echo [VPN] Swarm VPN IP: %SWARM_VPN_IP%

REM ── Step 3: Set environment for local agent ───────────────────────────────
set PORT=3099
set BOT_NAME=edge-node
set BOT_ROLE=edge/local-executor
set AGENT_CAPABILITIES=edge-agent,mcp,local-executor
set SWARM_MODE=container
set ENABLE_AGENT_SWARM=true
set ENABLE_QUEUE_MANAGER=false
set ENABLE_AGENT_SCHEDULER=false
set RUN_MIGRATIONS=false
set MOCK_OIDC=true
set NODE_ENV=development
set CONFIG_OUTPUT_DIR=.\output-local-agent
set CONFIG_WRITE_MODE=split
set NODE_OPTIONS=--max-old-space-size=4096

REM Use VPN IP for infrastructure
set REDIS_URL=redis://%SWARM_VPN_IP%:6379
set DATABASE_URL=postgresql://oshal:oshalpass@%SWARM_VPN_IP%:5432/oshal
set CHROMADB_URL=http://%SWARM_VPN_IP%:8000

REM Load .env for API keys
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set "%%a=%%b"
    )
)

set LLM_PROVIDER=claude-code
set LLM_MODEL=claude-sonnet-4-5-20250929

REM ── Step 4: Generate stable agent ID ──────────────────────────────────────
set AGENT_ID_FILE=%USERPROFILE%\.oshal-edge-agent-id
if exist %AGENT_ID_FILE% (
    set /p AGENT_ID=<%AGENT_ID_FILE%
) else (
    for /f %%i in ('powershell -Command "[guid]::NewGuid().ToString()"') do set AGENT_ID=%%i
    echo %AGENT_ID%>%AGENT_ID_FILE%
)

REM ── Step 5: Create output dir and seed config ─────────────────────────────
if not exist output-local-agent mkdir output-local-agent
if exist config-seed\global-config.json copy /y config-seed\global-config.json output-local-agent\ >nul
if exist config-seed\secrets.json copy /y config-seed\secrets.json output-local-agent\ >nul

echo.
echo   +--------------------------------------------------+
echo   ^|  OSHAL Local Agent                               ^|
echo   +--------------------------------------------------+
echo   ^|  AGENT_ID : %AGENT_ID%
echo   ^|  BOT_NAME : %BOT_NAME%
echo   ^|  PORT     : %PORT%
echo   ^|  REDIS    : %REDIS_URL%
echo   ^|  POSTGRES : %DATABASE_URL%
echo   ^|  VPN IP   : %TAILSCALE_IP%
echo   +--------------------------------------------------+
echo.
echo   Open in browser: http://localhost:%PORT%
echo.

REM ── Step 6: Start the agent ───────────────────────────────────────────────
npx ts-node --project tsconfig.json -r tsconfig-paths/register src/app/server.ts
