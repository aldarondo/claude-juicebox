# claude-juicebox — Roadmap

## Current Milestone
Deploy Docker Compose stack to Synology NAS and connect to claude-enphase coordinator

### 🔨 In Progress
[Empty]

### 🟢 Ready (Next Up)
- Deploy Docker Compose stack to Synology NAS — blocked on claude-synology SSH layer first
- Wire claude-juicebox into enphase-juicebox-coordinator for solar-aware charging

### 📋 Backlog
- Add MQTT topic documentation (charger → broker message format)
- Test full stack end-to-end with real JuiceBox hardware after NAS deploy

### 🔴 Blocked
- NAS deployment — blocked on `claude-synology` SSH layer (`lib/ssh.py` + `/synology-deploy`), which requires Charles to enable SSH on the NAS first

## ✅ Completed
- Docker Compose architecture designed (Mosquitto + JuicePassProxy + MCP server)
- PLAN.md with full implementation detail
- MCP server scaffold and folder structure
- Mosquitto broker config template
- MCP tool: `get_charger_status` — charging state, power (W), current (A), voltage (V), temp (°C), MQTT status (2026-04-14)
- MCP tool: `get_session_info` — energy delivered (kWh), elapsed time, session start time (2026-04-14)
- MCP tool: `start_charging` — enable charging with configurable max amps (6–40A) (2026-04-14)
- MCP tool: `stop_charging` — stop/pause charging immediately (2026-04-14)
- MCP tool: `set_current_limit` — adjust max charging current mid-session (2026-04-14)
- MCP tool: `get_diagnostics` — firmware version, WiFi signal, MQTT status (2026-04-14)
- MCP tool: `get_charging_schedule` — return current weekly charging schedule (2026-04-14)
- MCP tool: `set_charging_schedule` — program weekly TOU-aware charging windows (2026-04-14)
- 23 unit tests — all pass (juiceboxClient + schedule tools) (2026-04-14)
- mcp-server/README.md with full tool reference and Docker deploy guide (2026-04-14)
