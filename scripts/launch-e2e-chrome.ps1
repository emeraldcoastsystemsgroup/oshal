# CHANGE LOG
# -----------------------------------------------------------------------------
# SEQ                 | AUTHOR        | DESCRIPTION
# -----------------------------------------------------------------------------
# 1 | maintainer@emeraldcoastsystemsgroup.com   | Launch a debuggable Chrome for the live E2E
#                     |               | suite to attach to (CDP). Sign in once here.
# -----------------------------------------------------------------------------
#
# Launches YOUR Chrome with a remote-debugging port and a dedicated profile so the
# headed live E2E suite (playwright.live.config.ts) can attach to it over CDP and
# run as you. A dedicated --user-data-dir is required: Chrome 136+ refuses the
# debug port on the default profile.
#
# Usage:
#   1. Run this script. A Chrome window opens at the cockpit.
#   2. Sign in once with Google (this is a REAL Chrome, so Google allows it).
#      The dedicated profile remembers it; you won't sign in again next time.
#   3. Leave the window open and run:  npm run test:live   (or the npx command).

param(
  [int]$Port = 9222,
  [string]$Url = "https://oshal.agenticfederal.us/cockpit/",
  [string]$ProfileDir = "$env:USERPROFILE\.oshal-e2e-chrome"
)

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
  $chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path $chrome)) {
  Write-Error "Chrome not found. Edit \$chrome in this script to your chrome.exe path."
  exit 1
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

Write-Host "Launching Chrome on debug port $Port with profile $ProfileDir"
Write-Host "Sign in once in the window, then run: npm run test:live"
& $chrome "--remote-debugging-port=$Port" "--user-data-dir=$ProfileDir" $Url
