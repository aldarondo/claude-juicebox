# claude-juicebox — Roadmap

## Current Milestone
End-to-end charging test + enphase-juicebox-coordinator integration

### 🔨 In Progress
[Empty]

### 🟢 Ready (Next Up)
- **End-to-end charging test** — plug in car and verify JPP receives directed UDP on port 8042, MQTT topics `hmd/sensor/JuiceBox/*/state` populate with live charging data (current, power, energy)
- **Wire into enphase-juicebox-coordinator** — connect set_charging_schedule to solar/TOU coordinator so Enphase data drives charging windows automatically

### 📋 Backlog
- Add MQTT topic documentation (charger → broker message format)
- Long-term: build custom JPP image with larger MITM_RECV_TIMEOUT (120s → 600s) to reduce idle-state container restarts (currently restarts every ~3.3 hrs when idle, which is acceptable)

### 🔴 Blocked
[Empty]

## ✅ Completed
- **DHCP intercept working — JuiceBox at .2 with DNS .64 (2026-04-18)**
  - Root cause of DHCP failure identified: dhcp-host had the ZentriOS hardware MAC (`4c:55:cc:14:50:e8`) instead of the Wi-Fi/DHCP MAC (`52:d4:f7:14:50:e8`) — dnsmasq was silently ignoring all JuiceBox DHCP requests due to mismatch
  - Cox DHCP starting address changed from .2 → .3 (permanently removes .2 from Cox's pool)
  - Cox DHCP ending address temporarily set to .196 to force JuiceBox off its Cox-held .197 lease via DHCPNAK, triggering fresh DISCOVER that dnsmasq won; ending address later restored to .253
  - JuiceBox now boots to `192.168.0.2` with DNS `192.168.0.64` ✓
  - JPP confirmed receiving live UDP telemetry from charger immediately on next boot ✓
  - MQTT topics populating: Status=Unplugged, Voltage=243.2V, Temp=109.4°F, Lifetime=9595994 Wh ✓
  - Stable permanently: JuiceBox requests .2 on every reboot; Cox starts at .3 so Cox always rejects .2; dnsmasq always wins — no race condition

- **DNS override infrastructure deployed (2026-04-18)**
  - juicebox-dns (dnsmasq) container added, resolves `device-backend-udp-evos.juice.net` → `192.168.0.64`
  - JuiceBox static DNS config applied via telnet: static IP/gateway/netmask/DNS all saved to flash
  - Discovered: `wlan.dhcp.enabled 0` reverts to 1 after reboot on EMWERK firmware (likely Enel X cloud pushes it back)
  - Workaround: configure Cox router DHCP to hand out `192.168.0.64` as DNS server (see ROADMAP Ready)
  - Port correction: LOCAL_PORT and ENELX_SERVER_PORT fixed to 8042 (was 8047)
  - README rewritten with full protocol deep-dive, DNS approach rationale, troubleshooting guide
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
  - Connected to Claude Desktop at `http://192.168.0.64:3001/sse`; config confirmed in `claude_desktop_config.json` (2026-04-18)
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
