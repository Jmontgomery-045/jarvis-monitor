# Forwards Claude Code hook events to JARVIS Monitor's local endpoint.
#
# Wire it from your Claude Code settings.json, e.g.:
#   "hooks": {
#     "PreToolUse":   [{ "matcher": "*", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:/Dev/jarvis-monitor/hooks/notify.ps1 -Event PreToolUse" }] }],
#     "PostToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:/Dev/jarvis-monitor/hooks/notify.ps1 -Event PostToolUse" }] }],
#     "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:/Dev/jarvis-monitor/hooks/notify.ps1 -Event UserPromptSubmit" }] }],
#     "Stop": [{ "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:/Dev/jarvis-monitor/hooks/notify.ps1 -Event Stop" }] }]
#   }

param(
  [string]$Event = 'event'
)

$payload = $null
try { $payload = [Console]::In.ReadToEnd() } catch {}
if ([string]::IsNullOrWhiteSpace($payload)) { $payload = '{}' }

$parsed = $null
try { $parsed = $payload | ConvertFrom-Json -ErrorAction Stop } catch { $parsed = $payload }

$body = @{
  event   = $Event
  payload = $parsed
} | ConvertTo-Json -Depth 8 -Compress

try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:7373/hook' `
    -Method Post `
    -Body $body `
    -ContentType 'application/json' `
    -TimeoutSec 1 | Out-Null
} catch { }

exit 0
