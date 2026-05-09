# JARVIS Monitor

Borderless circular HUD that visualizes Claude Code activity in real time — sessions, subagents, brain (memory) files, tasks, and live hook events — all flowing around a glowing core.

## Run

```powershell
cd C:\Dev\jarvis-monitor
npm install
npm start
```

## What it shows

Reads live data from `~/.claude/`:

| Source | Visual |
| --- | --- |
| `projects/<key>/<sessionId>.jsonl` | Session node orbiting its project |
| `projects/<key>/<sessionId>/subagents/agent-*` | Subagent satellite around session |
| `projects/<key>/memory/*.md` | Memory dot near project |
| `tasks/<sessionId>/*.json` | Task count on session detail |
| `hooks/notify.ps1` (POST `/hook`) | Expanding pulse from core |

Active = activity within the last 30s (warm gold pulse). Idle = cyan.

Click any node to pin it in the HUD panel.

## Komorebi

The window is a normal frameless window (not always-on-top, no skip-taskbar) so Komorebi tiles it cleanly. Title is `JARVIS Monitor`, AUMID is `com.jmont.jarvis-monitor`. To float it instead, add a rule to your komorebi config or `applications.json`.

## Hooks (optional, for live signal)

Append to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:/Dev/jarvis-monitor/hooks/notify.ps1 -Event PreToolUse" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File C:/Dev/jarvis-monitor/hooks/notify.ps1 -Event PostToolUse" }] }]
  }
}
```

The hook script POSTs to `http://127.0.0.1:7373/hook`. Override the port with `JARVIS_HOOK_PORT`.
