@echo off
REM =============================================================================
REM OSHAL runtime helper (Windows)
REM =============================================================================
REM CHANGE LOG
REM -----------------------------------------------------------------------------
REM SEQ                 | AUTHOR                      | DESCRIPTION
REM -----------------------------------------------------------------------------
REM 1 | maintainer@emeraldcoastsystemsgroup.com   | Windows equivalent of oshal.sh for Docker Desktop on Windows
REM =============================================================================

setlocal enabledelayedexpansion

set "ROOT_DIR=%~dp0"
set "MAIN_COMPOSE_FILE=%ROOT_DIR%docker-compose.yml"
set "CORE_COMPOSE_FILE=%ROOT_DIR%docker-compose.core.yml"
set "SWARM_COMPOSE_FILE=%ROOT_DIR%docker-compose.swarm-local.yml"

if "%~1"=="" goto :usage
if "%~1"=="help" goto :usage
if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage

REM Check prerequisites
where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: docker is required.
    exit /b 1
)

docker compose version >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: docker compose is required.
    exit /b 1
)

REM Ensure .env exists
if not exist "%ROOT_DIR%.env" (
    if exist "%ROOT_DIR%.env.example" (
        copy "%ROOT_DIR%.env.example" "%ROOT_DIR%.env" >nul
        echo Created .env from .env.example
    ) else (
        echo WARNING: No .env or .env.example found. Create .env before running stack.
    )
)

REM Ensure mount-point directories exist
if not exist "%ROOT_DIR%output" mkdir "%ROOT_DIR%output"
if not exist "%ROOT_DIR%workspace" mkdir "%ROOT_DIR%workspace"
if not exist "%ROOT_DIR%workspace-shared" mkdir "%ROOT_DIR%workspace-shared"
if not exist "%ROOT_DIR%any-bot\ui-cockpit" mkdir "%ROOT_DIR%any-bot\ui-cockpit"
if not exist "%ROOT_DIR%any-bot\ui-enhanced" mkdir "%ROOT_DIR%any-bot\ui-enhanced"

set "ACTION=%~1"
shift

if "%ACTION%"=="status" goto :status
if "%ACTION%"=="refresh-api" goto :refresh_api
if "%ACTION%"=="refresh-core" goto :refresh_core
if "%ACTION%"=="refresh-all" goto :refresh_all
if "%ACTION%"=="main-logs" goto :main_logs
if "%ACTION%"=="core-up" goto :core_up
if "%ACTION%"=="core-down" goto :core_down
if "%ACTION%"=="core-logs" goto :core_logs
if "%ACTION%"=="swarm-up" goto :swarm_up
if "%ACTION%"=="swarm-down" goto :swarm_down
if "%ACTION%"=="swarm-logs" goto :swarm_logs
if "%ACTION%"=="up" goto :full_up
if "%ACTION%"=="down" goto :full_down

echo Unknown action: %ACTION%
goto :usage

:usage
echo.
echo OSHAL runtime helper (Windows)
echo.
echo Usage:
echo   oshal.bat help
echo   oshal.bat status
echo   oshal.bat up                       Start everything (swarm infra + main stack)
echo   oshal.bat down                     Stop everything
echo   oshal.bat refresh-api              Rebuild and restart main api-server
echo   oshal.bat refresh-core             Rebuild and restart core api-server
echo   oshal.bat refresh-all              Rebuild both api-servers
echo   oshal.bat main-logs [service]      Follow main stack logs
echo   oshal.bat core-up                  Start core stack
echo   oshal.bat core-down                Stop core stack
echo   oshal.bat core-logs [service]      Follow core stack logs
echo   oshal.bat swarm-up                 Start swarm infrastructure + bots
echo   oshal.bat swarm-down               Stop swarm infrastructure + bots
echo   oshal.bat swarm-logs [service]     Follow swarm logs
echo.
echo Hot-swap summary:
echo   - docker-compose.yml api-server (:3456) is the historical/default runtime
echo   - docker-compose.core.yml api-server (:35456) is the standalone convenience stack
echo   - docker-compose.swarm-local.yml bot services (:3010-3025) ARE hot-swapped
echo.
exit /b 0

:status
echo === Main runtime (:3456, historical/default) ===
docker compose -f "%MAIN_COMPOSE_FILE%" ps
echo.
echo === Core runtime (:35456, standalone convenience stack) ===
docker compose -f "%CORE_COMPOSE_FILE%" ps 2>nul || echo   (not running)
echo.
echo === Swarm runtime (:3010-3025) ===
docker compose -f "%SWARM_COMPOSE_FILE%" ps
echo.
goto :eof

:refresh_api
docker compose -f "%MAIN_COMPOSE_FILE%" up -d --build api-server
goto :eof

:refresh_core
docker compose -f "%CORE_COMPOSE_FILE%" up -d --build api-server
goto :eof

:refresh_all
docker compose -f "%MAIN_COMPOSE_FILE%" up -d --build api-server
docker compose -f "%CORE_COMPOSE_FILE%" up -d --build api-server
goto :eof

:main_logs
docker compose -f "%MAIN_COMPOSE_FILE%" logs -f %1 %2 %3 %4 %5
goto :eof

:core_up
docker compose -f "%CORE_COMPOSE_FILE%" up -d --build %1 %2 %3 %4 %5
goto :eof

:core_down
docker compose -f "%CORE_COMPOSE_FILE%" down %1 %2 %3 %4 %5
goto :eof

:core_logs
docker compose -f "%CORE_COMPOSE_FILE%" logs -f %1 %2 %3 %4 %5
goto :eof

:swarm_up
docker compose -f "%SWARM_COMPOSE_FILE%" up --build -d %1 %2 %3 %4 %5
goto :eof

:swarm_down
docker compose -f "%SWARM_COMPOSE_FILE%" down %1 %2 %3 %4 %5
goto :eof

:swarm_logs
if "%~1"=="" (
    docker compose -f "%SWARM_COMPOSE_FILE%" logs -f project-manager
) else (
    docker compose -f "%SWARM_COMPOSE_FILE%" logs -f %1 %2 %3 %4 %5
)
goto :eof

:full_up
echo [oshal] Starting swarm infrastructure...
docker compose -f "%SWARM_COMPOSE_FILE%" up --build -d
echo.
echo [oshal] Starting main stack...
docker compose -f "%MAIN_COMPOSE_FILE%" up --build -d
echo.
echo [oshal] All services started.
echo   API Server:     http://localhost:3456
echo   Keycloak Admin: http://localhost:8080/admin (admin/admin)
echo   Code Server:    http://localhost:8443
goto :eof

:full_down
echo [oshal] Stopping main stack...
docker compose -f "%MAIN_COMPOSE_FILE%" down
echo.
echo [oshal] Stopping swarm infrastructure...
docker compose -f "%SWARM_COMPOSE_FILE%" down
echo.
echo [oshal] All services stopped.
goto :eof