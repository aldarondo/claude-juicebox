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
- **Charger IP is not actually pinned by dnsmasq** — the charger currently holds `192.168.0.13`, a lease dnsmasq never granted (its pool is `192.168.0.2`–`JUICEBOX_IP`). In 6000 lines of `juicebox-dns` log there is *zero* DHCP activity for either charger MAC (`4c:55:cc:14:50:e8` hardware / `52:d4:f7:14:50:e8` WiFi), while the Nirvana pump ACKs fine — so the Cox router is winning the charger's DHCP, or the charger's 12h renewal falls outside the log window. Consequence: `JUICEBOX_HOST` will drift again on the next lease change and silently break the ZentriOS tools. Needs a decision (see below) — not fixed here because every option touches LAN-wide DHCP.
  - Option A: widen `JUICEBOX_IP` to `.13` — one-line change, but widens dnsmasq's pool to `.2`–`.13` and risks handing out addresses that collide with Cox's range.
  - Option B: set a Cox static DHCP reservation for `4c:55:cc:14:50:e8` at whatever IP it should hold, and leave dnsmasq out of the charger's DHCP entirely.
  - Option C: put the charger back on a static config (`scripts/set_static_ip.py`); `wlan.dhcp.enabled` is currently `1`, so the static config that script writes is not in effect.

- **Charging schedule is in-memory only — every container restart silently drops it** — recreating `juicebox-mcp` during today's fix took `/health` from `schedule_jobs: 4` to `schedule_jobs: 0`. Nothing warns; the charger simply has no windows until the coordinator next pushes one, and `set_charging_schedule` also stops any charge in progress if the current time is outside the new windows (`stopped_immediately: true`). Every deploy therefore silently disarms TOU avoidance for up to a day. Options: persist `activeSchedule` to the existing `/logs` bind mount and reload on boot, or have the coordinator re-push on a health-check mismatch.

## ✅ Completed

- **VPN recurrence closed with a tested watchdog (2026-08-08)** — follow-up to the tunnel outage below. **Correcting two things stated when that was first logged:** (1) the suggested `remote us.nordvpn.com` group hostname does **not** work on Synology — `synovpnc` resolves `remote=` to a single server IP itself and rejects a multi-A round-robin host with `SetServerIP() failed` / `CreateOVPNConnection failed`; only single-A-record server hostnames work. (2) `verify-x509-name … name-suffix` is **not valid OpenVPN** (`unknown X.509 name type`); the only types are `subject` / `name` / `name-prefix`. Since the config therefore can't be made self-healing, durability moved into `/usr/local/bin/vpn-watchdog.sh`, run every 10 min from `/etc/crontab`. Health test is "default route is `tun0` **and** a curl succeeds" — no hardcoded WAN IP, and it distinguishes a zombie (route but no traffic) from a torn-down tunnel (traffic but un-VPN'd). Escalates: reconnect → API-lookup a live US server and repoint `remote=` / `remote` / `verify-x509-name CN=` together → on total failure restore the prior config and `kill_client`, so the NAS is never left black-holed. Both paths tested live: torn-down tunnel recovered in **14 s**; a config pointed at the genuinely-retired `us8589.nordvpn.com` auto-repointed to `us13154.nordvpn.com` and recovered in **2m18s**. Logs to `/var/log/vpn-watchdog.log`. DSM notes: `/etc/crontab` needs real tabs (verify `cat -A` shows `^I`) and the reload is `/usr/syno/bin/synosystemctl restart crond`.

- **🐛 NAS NordVPN tunnel dead — server decommissioned; repointed and restored (2026-08-08)** — blocked `docker compose pull` and both CI deploys (NAS-side `cloudflared` needs outbound to hold the tunnel, hence `websocket: bad handshake` — not a Cloudflare fault). `get_conn` claimed connected with ~26 days uptime while `tun0` held the default route and black-holed everything. **Root cause: NordVPN retired the pinned server.** `us8589.nordvpn.com` no longer resolves (`No answer`) and the pinned raw IP `91.196.220.56` did not answer on TCP 443; every redial failed with `TLS key negotiation failed to occur within 60 seconds`. Not a credentials or syntax problem. Fix: repointed to `us13142.nordvpn.com` (Phoenix, load 5, verified live at 187.14.115.102) in all **three** places — `remote=` in `ovpnclient.conf`, `remote` in `client_o1774644869`, and `verify-x509-name CN=` in the same file, which is the easy one to miss since a mismatch fails TLS. Backups at `*.bak.20260808`. Verified genuinely carrying traffic: egress flipped `70.176.88.83` → `187.14.115.103`, RX/TX climbing, ghcr.io 401 in 0.34 s, api.cloudflare.com 301 in 0.16 s, and the route-up script reapplied the Enlighten bypass routes automatically. Credentials never re-entered — DSM writes them to `/tmp/ovpn_client_up` from `ovpnclient.conf` at connect time. Two diagnostic traps recorded in [[nordvpn-zombie-tunnel-recovery]]: "no `openvpn` process" is a `ps w` artifact and NOT a valid zombie signal (`sudo ps aux` shows them), and `synovpnc` is absent from a non-login shell's PATH so it must be called as `/usr/syno/bin/synovpnc`.

- **🐛 CI: "Deploy to NAS" reported success while failing — both build workflows (2026-08-08)** — the retry loop ended in `... && break || { echo "...retrying..."; sleep 10; }`, so after three failed SSH attempts the step's exit status was the final `echo`/`sleep` — i.e. 0. Today all three attempts failed against the dead Cloudflare tunnel and the run went green: the image was built and pushed to GHCR while the NAS silently kept running a 3-month-old one (`b7d64a99`, dated 3 months). Fixed in `build-juicebox-mcp.yml` and `build-juicepassproxy.yml` with an explicit `deployed` flag and `exit 1`. `deploy-compose.yml` already had the correct `failed after 3 attempts; return 1` guard, which is why *it* went red. Also re-enabled both build workflows — GitHub had set them to `disabled_inactivity`, and a disabled workflow ignores its `push:` trigger too, so nothing rebuilt on push at all.

- **🐛 `get_diagnostics` always reported `wifi_rssi: null` — Node connection pooling vs. ZentriOS (2026-08-08)** — surfaced while verifying the `JUICEBOX_HOST` fix below. ZentriOS closes the TCP connection after every response, but Node ≥19's global agent defaults to `keepAlive: true`, so it pools the dead socket and the next *sequential* request reuses it and fails with `socket hang up`. `get_diagnostics` calls `getSystemInfo()` (5 parallel) and then `getRssi()` immediately after — the parallel batch always succeeded (no idle sockets to reuse yet) while the single trailing call always failed, which made it look like a charger-side quirk rather than connection reuse. Confirmed by A/B against the live charger: pooling on → `FAIL / OK / FAIL` across three sequential calls; `agent: false` → `OK / OK / OK` at −54 dBm. Fixes: `agent: false` in `runCommand` so each request gets a fresh connection; replaced the bare `catch {}` around both ZentriOS calls in `get_diagnostics` with `console.error` logging, since a silent null for a live charger is what hid this (and the missing `JUICEBOX_HOST`) in the first place. 51 tests pass.

- **🐛 ZentriOS side channel dead — `JUICEBOX_HOST` never reached the MCP container (2026-08-08)** — `get_diagnostics` returned `ZentriOS request timed out` for firmware/uptime/UUID/memory and `null` WiFi RSSI, while MQTT telemetry and start/stop worked perfectly. Two compounding faults: (1) the `juicebox-mcp` service in `docker-compose.yml` never passed `JUICEBOX_HOST` through — only `PORT`/`MQTT_*` were in its `environment:` block — so `zentriosClient.js` fell back to its hardcoded `192.168.0.2`, which answers nothing (ARP `incomplete`, curl exit 7); (2) the configured value was stale anyway — `.env` said `192.168.0.4`, also dead, while the charger actually sits at `192.168.0.13` (confirmed: ARP `4c:55:cc:14:50:e8` on eth1, ping 0% loss, `GET /command/version` → HTTP 200, `get wlan.network.ip` → `192.168.0.13`). Because the ZentriOS path is entirely separate from MQTT, the whole failure was invisible to normal charging use. Fixes: added `JUICEBOX_HOST` + `ZENTRIOS_TIMEOUT` passthrough to the `juicebox-mcp` service; removed the hardcoded `192.168.0.2` fallback in favour of a fail-fast error naming the missing var; documented `JUICEBOX_HOST` in `mcp-server/.env.example` (it was absent, which is how the omission slipped through); pointed NAS `.env` at `.13` (backup at `.env.bak-20260808`); fixed the stale `192.168.0.141` comment on the JPP service. 51 tests pass. Underlying IP-drift cause logged under 🔴 Blocked.

- **🐛 Deploy fix (2026-04-25)** — `Bind mount failed: '/volume1/docker/claude-juicebox/logs' does not exist` after the `mcp-logs` named volume → bind-mount conversion. Added `ensure_dirs` step to `deploy-compose.yml` that runs `mkdir -p /volume1/docker/claude-juicebox/logs` on the NAS before `docker compose up -d`. Mirrors the pattern other coordinators use; future bind mounts can be added to the same function.

- **Schedule enhancements + hardening (2026-04-25)** — `pause_charging_schedule` / `resume_charging_schedule` new MCP tools; schedule mutex lock (`withScheduleLock`); retry callbacks with exponential backoff (30s/60s/120s cap) on cron failures; log rotation extended to 5 numbered backup files with `LOG_MAX_FILES`; `LOG_LEVEL` env var added; NAS deploy key docs added (`docs/nas-deploy-key-setup.md`); 51 tests passing (up from 39)

- **QA hardening pass — 18 findings fixed across security, code quality, tests, and config (2026-04-22)**
  - *Security (Critical):* GitHub Actions SSH auth migrated from password (`sshpass`) to key-based auth (`NAS_SSH_KEY` secret + `~/.ssh/id_ed25519`); deploy key generated and authorized on NAS
  - *Security (Major):* `StrictHostKeyChecking=no` → `StrictHostKeyChecking=accept-new` in all 3 CI workflows
  - *Tests:* 5 error-path tests added (get_charger_status/get_session_info/get_diagnostics when state is null or MQTT offline); 39 tests total, all passing
  - *Code quality:* `constants.js` module extracted (`STATUS`, `MQTT_CMD`); `structuredClone()` in `getState()`; `TZ_OVERRIDE` env var for schedule timezone; schedule time range validation (hours < 24, minutes < 60); cron jobs track consecutive failures with warning at 3+
  - *Docker:* `juicebox-mcp` healthcheck added; image tags parameterized (`${MCP_IMAGE_TAG:-latest}`, `${JPP_IMAGE_TAG:-latest}`)
  - *Config:* `dnsmasq.conf` replaced with `dnsmasq.conf.template` — `LOCAL_IP`, `JUICEBOX_IP`, `GATEWAY_IP` now read from `.env` via `sed` substitution at container start; NAS `.env` and template deployed
  - *Docs:* Integration testing section added to README; GitHub Actions secrets table added; stale `MQTT_STATE_TOPIC`/`MQTT_CMD_TOPIC` references removed throughout

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
- ❌ [docker-monitor:deploy-failed] GitHub Actions deploy failed (run #31924002574) — https://github.com/aldarondo/claude-juicebox/actions/runs/31924002574 — 2026-08-21 08:00 UTC

[Empty]
