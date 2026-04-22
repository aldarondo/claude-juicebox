# claude-juicebox — Roadmap

## Current Milestone
✅ Project complete — stack is live, Claude Desktop connected, coordinator wired

### 🔨 In Progress
[Empty]

### 🟢 Ready (Next Up)
[Empty]

### 📋 Backlog
[Empty]

### 🔴 Blocked
[Empty]

## ✅ Completed

- **Live tests passed — all 5 MCP tools verified with car connected (2026-04-22)** — `stop_charging` ✅ (Charging→Plugged In, 0A in ~3s), `start_charging` ✅ (Plugged In→Charging, 31.7A / 7.7kW), `set_current_limit` ✅ (throttled 31.7A→15.8A at 16A limit, restored to 31.6A on 32A restore), `get_session_info` ✅ (charging=true, 1.26kWh, session_start tracked correctly, elapsed_minutes accurate), `set_charging_schedule` ✅ (cron jobs created, schedule cleared). `stopped_immediately` live test deferred until new image deploys (code staged, CI will build).

- **Fix `set_charging_schedule` — immediate stop on schedule push (2026-04-22)** — Extracted `isTimeInSchedule()` to `scheduleUtils.js`; `set_charging_schedule` now calls `stopCharging()` immediately when current time falls outside all windows in new schedule. `stopped_immediately` field added to response. 34 unit tests passing (18 schedule + 16 juiceboxClient).

- **Fix `set_current_limit` — publish offline limit alongside online (2026-04-22)** — `setCurrentLimit()` now publishes `Max-Current-Offline-Wanted` before `Max-Current-Online-Wanted`, matching same pattern as `startCharging`. JPP requires both defined.

- **Fix `stop_charging` — confirmed working on live session (2026-04-22)** — Root cause was two missing config items: (1) `IGNORE_ENELX=true` not set in `docker-compose.yml` (JPP gated on this before sending any UDP); (2) `Max-Current-Offline-Wanted` uninitialized on fresh JPP start ("Must have both current_max defined" error). Fix: `IGNORE_ENELX=true` added to compose; `stopCharging()` and `startCharging()` now always publish offline limit first. Live test confirmed: JuiceBox transitioned Charging→Plugged In, Current dropped to 0A within ~3s of command.

- **Deploy pipeline hardened against zombie containers and duplicate networks (2026-04-21)** — Fixed workflow file with merge conflict markers (broke since fedb63b), then resolved `juicepassproxy` container-stopped blocker by refactoring deploy step to use `compose stop/rm` + full-path docker network cleanup before `up -d`; all four services now deploy cleanly.

- **End-to-end charging test passed (2026-04-18)** — car plugged in, JPP received directed UDP, MQTT topics populated with live data
- **Enphase-juicebox-coordinator wired (2026-04-18)** — coordinator calls `set_charging_schedule` via MCP SSE client; full loop: Enphase TOU tariff → optimizer → JuiceBox schedule
- **Custom JPP image with configurable MITM_RECV_TIMEOUT (2026-04-19)** — `juicepassproxy/Dockerfile` patches upstream image to read timeout from env var; `docker-compose.yml` sets `MITM_RECV_TIMEOUT=600` (reduces idle restarts from every ~3.3 hrs to ~10 min)
- **All services migrated to GHCR pre-built images (2026-04-19)** — both `juicepassproxy` and `juicebox-mcp` pull from `ghcr.io/aldarondo/...`; GitHub Actions workflows build and push on every relevant change; NAS never needs to build locally
- **Fully automated deploy pipeline (2026-04-19)** — GitHub Actions builds image and SSHes into NAS to run `docker compose pull && up -d` in one workflow; weekly Sunday cron (2am + 3am UTC) keeps both images current with no manual steps; `NAS_SSH_PASSWORD` GitHub secret required
- **MCP server refactored for SDK 1.9+ (2026-04-19)** — `McpServer` instantiated per connection via factory; fixed `get_session_info` bug (`s.state` → `s.status`, `"charging"` → `"Charging"` to match JPP topic value)
- **DHCP intercept working — JuiceBox at .2 with DNS .64 (2026-04-18)**
  - Root cause of DHCP failure identified: dhcp-host had the ZentriOS hardware MAC (`4c:55:cc:14:50:e8`) instead of the Wi-Fi/DHCP MAC (`52:d4:f7:14:50:e8`) — dnsmasq was silently ignoring all JuiceBox DHCP requests due to mismatch
  - Cox DHCP starting address changed from .2 → .3 (permanently removes .2 from Cox's pool)
  - Cox DHCP ending address temporarily set to .196 to force JuiceBox off its Cox-held .197 lease via DHCPNAK, triggering fresh DISCOVER that dnsmasq won; ending address later restored to .253
  - JuiceBox now boots to `<YOUR-JUICEBOX-IP>` with DNS `<YOUR-NAS-IP>` ✓
  - JPP confirmed receiving live UDP telemetry from charger immediately on next boot ✓
  - MQTT topics populating: Status=Unplugged, Voltage=243.2V, Temp=109.4°F, Lifetime=9595994 Wh ✓
  - Stable permanently: JuiceBox requests .2 on every reboot; Cox starts at .3 so Cox always rejects .2; dnsmasq always wins — no race condition

- **DNS override infrastructure deployed (2026-04-18)**
  - juicebox-dns (dnsmasq) container added, resolves `device-backend-udp-evos.juice.net` → `<YOUR-NAS-IP>`
  - JuiceBox static DNS config applied via telnet: static IP/gateway/netmask/DNS all saved to flash
  - Discovered: `wlan.dhcp.enabled 0` reverts to 1 after reboot on EMWERK firmware (likely Enel X cloud pushes it back)
  - Workaround: configure Cox router DHCP to hand out `<YOUR-NAS-IP>` as DNS server (see ROADMAP Ready)
  - Port correction: LOCAL_PORT and ENELX_SERVER_PORT fixed to 8042 (was 8047)
  - README rewritten with full protocol deep-dive, DNS approach rationale, troubleshooting guide
- **juicepassproxy idle-state behavior documented (2026-04-18)**
  - Confirmed charger (EMWERK-JB_1_1-1.4.0.28 firmware) only sends directed UDP when actively charging — broadcasts <YOUR-JUICEBOX-IP>:55555 discovery packets when idle
  - UDPC set to <YOUR-NAS-IP>:8047 via telnet; Enel X cloud pushes its own stream back (charger sends to both when charging)
  - MITM timeout (120s) causes container restart every ~3.3 hours when idle — expected behavior, not a bug; restarts immediately via Docker policy
  - Root cause of prior crashes confirmed: UPDATE_UDPC=true causes telnet timeout loop (readuntil mismatch) → 10 errors/60 min → crash; left as UPDATE_UDPC=false
  - DNS approach at router is the recommended long-term fix for persistent UDPC without UPDATE_UDPC
- **Full NAS deployment (2026-04-18)**
  - Deployed Mosquitto + JuicePassProxy + juicebox-mcp to `/volume1/docker/claude-juicebox`
  - Fixed LOCAL_IP auto-detection (VPN tun0 interference) via `LOCAL_IP=<YOUR-NAS-IP>` env var
  - Added `juicepassproxy-config` volume for persistence
  - UDPC redirect successful — JuiceBox now sends UDP to `<YOUR-NAS-IP>:8047`
  - Live charger data confirmed streaming via MQTT (Status: Charging, 124W, 247V)
  - Rewrote `juiceboxClient.js` for JuicePassProxy v0.5.x `hmd/` topic structure
  - Connected to Claude Desktop at `http://<YOUR-NAS-IP>:3001/sse`; config confirmed in `claude_desktop_config.json` (2026-04-18)
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

## 🚫 Blocked
[Empty]
