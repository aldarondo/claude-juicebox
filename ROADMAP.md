# claude-juicebox — Roadmap

## Current Milestone
Deploy Docker Compose stack to Synology NAS and connect to claude-enphase coordinator

### 🔨 In Progress
[Empty]

### 🟢 Ready (Next Up)

### 📋 Backlog
- Add MQTT topic documentation (charger → broker message format)
- Test full stack end-to-end with real JuiceBox hardware after NAS deploy (requires car plugged in — charger only sends directed UDP when actively charging/connected)
- Configure router DNS to point `device-backend-udp-evos.juice.net` → NAS IP for permanent UDPC redirect (avoids needing UPDATE_UDPC=true and the crash loop it causes)
- Long-term: build custom JPP image with larger MITM_RECV_TIMEOUT (120s → 600s) to reduce idle-state container restarts (currently restarts every ~3.3 hrs when idle, which is acceptable)

### 🔴 Blocked
[Empty]

## ✅ Completed
- **juicepassproxy idle-state behavior documented (2026-04-18)**
  - Confirmed charger (EMWERK-JB_1_1-1.4.0.28 firmware) only sends directed UDP when actively charging — broadcasts 192.168.0.141:55555 discovery packets when idle
  - UDPC set to 192.168.0.64:8047 via telnet; Enel X cloud pushes its own stream back (charger sends to both when charging)
  - MITM timeout (120s) causes container restart every ~3.3 hours when idle — expected behavior, not a bug; restarts immediately via Docker policy
  - Root cause of prior crashes confirmed: UPDATE_UDPC=true causes telnet timeout loop (readuntil mismatch) → 10 errors/60 min → crash; left as UPDATE_UDPC=false
  - DNS approach at router is the recommended long-term fix for persistent UDPC without UPDATE_UDPC
- **Full NAS deployment (2026-04-18)**
  - Deployed Mosquitto + JuicePassProxy + juicebox-mcp to `/volume1/docker/claude-juicebox`
  - Fixed LOCAL_IP auto-detection (VPN tun0 interference) via `LOCAL_IP=192.168.0.64` env var
  - Added `juicepassproxy-config` volume for persistence
  - UDPC redirect successful — JuiceBox now sends UDP to `192.168.0.64:8047`
  - Live charger data confirmed streaming via MQTT (Status: Charging, 124W, 247V)
  - Rewrote `juiceboxClient.js` for JuicePassProxy v0.5.x `hmd/` topic structure
  - Connected to Claude Desktop at `http://192.168.0.64:3001/sse`
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
