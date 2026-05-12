# JARVIS Monitor

Borderless circular HUD that visualizes Claude Code activity in real time — sessions, subagents, brain (memory) files, tasks, and live hook events — all flowing around a glowing core.

## Run

```powershell
git clone https://github.com/Jmontgomery-045/jarvis-monitor.git
cd jarvis-monitor
copy config.example.json config.json   # then edit to taste
npm install
npm start
```

## Configuration

All paths and ports live in `config.json` (gitignored). Copy `config.example.json` and edit:

```json
{
  "hookPort": 7373,
  "usageCachePath": null,
  "sources": [
    {
      "id": "win",
      "label": "Windows",
      "color": "#6ee0ff",
      "claudeDir": "~/.claude",
      "shellsRoot": "%LOCALAPPDATA%/Temp/claude"
    }
  ]
}
```

Path values support `~` (home directory) and `%ENVVAR%` expansion.

- **`hookPort`** — local HTTP port the hook receiver binds to. Overridable at runtime with `JARVIS_HOOK_PORT`.
- **`usageCachePath`** — optional path to a JSON cache exposing Claude usage percentages (`personal_raw`, `work_raw`, `*_fetched_at`, `*_backoff_until`). Set to `null` to hide the usage row.
- **`sources[]`** — one or more Claude installs to watch. Each can include `claudeDir` (required), `shellsRoot` (Windows `%LOCALAPPDATA%/Temp/claude`), and `procPath` (e.g. WSL `\\\\wsl.localhost\\Ubuntu\\proc` for cross-OS PID liveness checks).

## What it shows

Reads live data from each configured source's `claudeDir`:

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

The window is a normal frameless window (not always-on-top, no skip-taskbar) so Komorebi tiles it cleanly. Title is `JARVIS Monitor`, AUMID is `com.jarvis.monitor`. To float it instead, add a rule to your komorebi config or `applications.json`.

## Hooks (optional, for live signal)

Append to `~/.claude/settings.json` (replace `<path-to-repo>` with the absolute path where you cloned this repo):

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File <path-to-repo>/hooks/notify.ps1 -Event PreToolUse" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "pwsh -NoProfile -File <path-to-repo>/hooks/notify.ps1 -Event PostToolUse" }] }]
  }
}
```

The hook script POSTs to `http://127.0.0.1:7373/hook`. Override the port with `JARVIS_HOOK_PORT` (read by both the app and `notify.ps1`).

## License

MIT — see [LICENSE](LICENSE).
