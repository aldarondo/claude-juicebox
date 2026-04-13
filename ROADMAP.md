# claude-juicebox — Roadmap

## Current Milestone
Working MCP server with Docker Compose stack controlling the JuiceBox Pro 40

### 🔨 In Progress
[Empty]

### 🟢 Ready (Next Up)
- Implement MCP tool: `get_charging_status` — read current session state from MQTT
- Implement MCP tool: `set_charging_current` — publish current-limit command to MQTT
- Implement MCP tool: `get_session_info` — energy delivered, duration, cost estimate
- Test full stack locally with `docker-compose up` before NAS deployment

### 📋 Backlog
- Implement MCP tool: `start_charging` / `stop_charging`
- Implement MCP tool: `get_diagnostics` — charger firmware, signal strength, error codes
- Deploy Docker Compose stack to Synology NAS
- Wire claude-juicebox into enphase-juicebox-coordinator for solar-aware charging
- Add MQTT topic documentation (charger → broker message format)

### 🔴 Blocked
[Empty]

## ✅ Completed
- Docker Compose architecture designed (Mosquitto + JuicePassProxy + MCP server)
- PLAN.md with full implementation detail
- MCP server scaffold and folder structure
- Mosquitto broker config template
