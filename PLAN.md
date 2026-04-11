# JuiceBox MCP Server — Project Plan

## Goal

Restore local control of a JuiceBox Pro 40 EV charger (post-Enel X / JuiceNet shutdown)
and expose it as an MCP server so Claude can monitor and control it.

---

## Your Setup

| Item | Value |
|------|-------|
| Charger model | JuiceBox Pro 40 |
| Charger name | JuiceBox-0E8 |
| Charger local IP | `192.168.0.141` (configurable in `.env`) |
| Max amperage | 40A |
| NAS IP | `192.168.0.64` |
| MCP server language | Node.js |

---

## Architecture

```
JuiceBox Pro 40 (UDP :8042)
         │
         ▼  (one-time UDPC update — automatic, see Step 2)
  ┌──────────────────────┐
  │    JuicePassProxy    │  Docker on Synology @ 192.168.0.64
  └──────────┬───────────┘
             │ publishes state via MQTT
             ▼
  ┌──────────────────────┐
  │  Mosquitto MQTT      │  Docker on Synology (port 1883)
  └──────────┬───────────┘
             │ subscribed by MCP server
             ▼
  ┌──────────────────────┐
  │   juicebox-mcp       │  Docker on Synology (port 8080)
  │   (Node.js MCP SSE)  │
  └──────────┬───────────┘
             │ MCP over SSE
             ▼
       Claude / Cowork
       → Add server: http://192.168.0.64:8080/sse
```

---

## Redirect Method: UDPC Auto-Update (Recommended)

JuicePassProxy has a built-in flag (`--update_udpc`) that automatically telnets into
the JuiceBox and updates the "UDPC" setting — which is the charger's configured
destination for its UDP traffic. This is a one-time change stored on the charger.

**Why this is the best option:**
- No router or DNS changes needed
- JuicePassProxy handles it automatically on first startup
- The charger will keep pointing to the NAS even after reboots
- If you ever want to revert, you run `set udpc` via telnet manually

**What it does under the hood:**
```
telnet 192.168.0.141  (into the JuiceBox)
→ set udpc 192.168.0.64:8042
→ save
→ reboot
```

JuicePassProxy does all of this for you when `UPDATE_UDPC=true` is set in `.env`.
After the first successful run, set it back to `false`.

---

## Files to Be Created

### `docker-compose.yml`
Deploys three containers on the Synology NAS:

| Container | Image | Port |
|-----------|-------|------|
| `juicebox-mosquitto` | `eclipse-mosquitto:2` | 1883 |
| `juicepassproxy` | `ghcr.io/juicerescue/juicepassproxy:latest` | 8042/udp |
| `juicebox-mcp` | Built from `./mcp-server` | 8080 |

Note: `juicepassproxy` runs in **host network mode** so it can directly reach
`192.168.0.141`. The other two containers use the default bridge network.

---

### `.env.example`
```
# JuiceBox
JUICEBOX_HOST=192.168.0.141
JUICEBOX_ID=JuiceBox-0E8

# First-time setup only: set to true to auto-update the charger's UDPC setting
# Set back to false after first successful run
UPDATE_UDPC=false

# MQTT (leave blank for no auth — fine for local-only use)
MQTT_USER=
MQTT_PASS=

# Enel X relay (JuicePassProxy forwards to this as a fallback — can leave as-is)
ENELX_SERVER_HOST=juicenet-udp-prod3-usa.enelx.com
ENELX_SERVER_PORT=8042
```

---

### `mosquitto/config/mosquitto.conf`
Minimal config: anonymous access (local network only), persistence enabled,
WebSocket listener on 9001 for optional debugging.

---

### `mcp-server/` — Node.js MCP Server

**Files:**

| File | Purpose |
|------|---------|
| `server.js` | MCP server entry point, SSE transport, tool definitions |
| `juiceboxClient.js` | MQTT subscriber — parses JuicePassProxy topics, maintains charger state |
| `package.json` | Dependencies: `@modelcontextprotocol/sdk`, `mqtt`, `express` |
| `Dockerfile` | `node:20-alpine`, runs `node server.js` |

**MCP Tools exposed to Claude:**

| Tool | Description |
|------|-------------|
| `get_charger_status` | Charging state, power (W), current (A), voltage (V), temp (°C) |
| `get_session_info` | Active session energy (kWh), elapsed time, start time |
| `start_charging` | Enable charging |
| `stop_charging` | Disable / pause charging |
| `set_current_limit` | Set max amps (6–40A for JuiceBox Pro 40) |
| `get_diagnostics` | Firmware version, WiFi signal strength, uptime |

---

### `docs/SYNOLOGY_SETUP.md`
Step-by-step guide:
1. SSH into NAS, clone repo to a shared folder
2. Copy `.env.example` → `.env`, set `JUICEBOX_HOST=192.168.0.141`
3. First run: set `UPDATE_UDPC=true` in `.env`
4. Deploy: `docker-compose up -d` (or import via Container Manager UI)
5. Watch logs to confirm UDPC update succeeded: `docker logs juicepassproxy`
6. Set `UPDATE_UDPC=false`, restart juicepassproxy: `docker-compose restart juicepassproxy`
7. Verify MQTT data: `docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v`
8. Add MCP server to Claude: `http://192.168.0.64:8080/sse`
9. Test by asking Claude: *"What is the status of my JuiceBox charger?"*

---

## What Is NOT in Scope (can be added later)

- Home Assistant integration
- Remote/cloud access
- Historical data logging
- Scheduled charging via MCP (JuicePassProxy may support this — TBD)

---

## Ready to Build?

If this plan looks good, say the word and I'll create all the files above.
The only thing to double-check first: make sure **port 8042 UDP** and **port 8080 TCP**
are not already in use on your Synology NAS.
