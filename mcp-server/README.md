# JuiceBox MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that lets Claude monitor and control a **JuiceBox Pro 40 EV charger** via MQTT.

Charger state is read from [JuicePassProxy](https://github.com/JuiceRescue/juicepassproxy), which intercepts the JuiceBox's UDP traffic and republishes it to a local Mosquitto broker. Commands (start, stop, set current, schedule) are published back to Mosquitto, which JuicePassProxy forwards to the charger.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 22+ | ESM (`"type": "module"`) |
| Mosquitto MQTT broker | Included in the root `docker-compose.yml` |
| JuicePassProxy | Intercepts UDP from the JuiceBox; also in `docker-compose.yml` |
| JuiceBox Pro 40 | Or any JuiceBox model supported by JuicePassProxy |

---

## Installation

```bash
npm install
```

---

## Configuration

Copy `.env.example` to `.env` and edit the values for your setup:

```bash
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP port the MCP server listens on |
| `MQTT_BROKER` | `mqtt://localhost:1883` | MQTT broker URL |
| `MQTT_USER` | _(none)_ | MQTT username (if broker requires auth) |
| `MQTT_PASS` | _(none)_ | MQTT password (if broker requires auth) |
| `LOG_FILE` | `/logs/mcp.log` | Path to the persistent log file (override for local dev) |

To watch all MQTT topics published by JuicePassProxy:

```bash
docker exec -it juicebox-mosquitto mosquitto_sub -t 'hmd/#' -v
```

---

## MQTT topic reference (JuicePassProxy v0.5.x)

JuicePassProxy v0.5+ publishes each charger field as a separate retained topic under the `hmd/` prefix. The MCP server subscribes to `hmd/#` and aggregates them into a single state object.

### State topics (read)

| Topic | Value | Notes |
|---|---|---|
| `hmd/sensor/JuiceBox/Status/state` | `Charging` \| `Standby` \| `Plugged In` \| ... | Charger state |
| `hmd/sensor/JuiceBox/Current/state` | float string | Amps |
| `hmd/sensor/JuiceBox/Voltage/state` | float string | Volts |
| `hmd/sensor/JuiceBox/Power/state` | int string | Watts |
| `hmd/sensor/JuiceBox/Temperature/state` | float string | °F |
| `hmd/sensor/JuiceBox/Energy--Session-/state` | int string | Wh this session |
| `hmd/sensor/JuiceBox/Energy--Lifetime-/state` | int string | Wh lifetime |
| `hmd/sensor/JuiceBox/Frequency/state` | float string | Hz |
| `hmd/sensor/JuiceBox/Power-Factor/state` | float string | — |
| `hmd/sensor/JuiceBox/Current-Rating/state` | int string | Max hardware amps |
| `hmd/number/JuiceBox/Max-Current-Online-Wanted-/state` | float string | Current amps setpoint |

### Command topics (write)

| Topic | Payload | Effect |
|---|---|---|
| `hmd/number/JuiceBox/Max-Current-Online-Wanted-/command` | `6`–`40` | Set charging current (amps) |
| `hmd/number/JuiceBox/Max-Current-Online-Wanted-/command` | `0` | Stop charging |

> **Note:** JuicePassProxy v0.5.x has no explicit start/stop command. Charging is controlled entirely by setting the current limit. Setting to `0` halts the session; restoring to a non-zero value resumes it.

---

## Running locally

```bash
npm start
```

The server starts on `PORT` (default 3001). Endpoints:

- `http://localhost:3001/sse` — MCP SSE endpoint (connect Claude Desktop here)
- `http://localhost:3001/health` — Health check (returns MQTT connection status)

---

## Running tests

```bash
npm test          # run once and exit
npm run test:watch  # watch mode for development
```

Tests use [Vitest](https://vitest.dev/). The `mqtt` and `node-cron` packages are fully mocked, so no broker or charger is needed.

---

## Deploying (Docker)

The full stack — DNS, Mosquitto, JuicePassProxy, and this MCP server — is wired together by the **root `docker-compose.yml`** one level up.

All custom images are pre-built by GitHub Actions and hosted on GHCR. The NAS pulls them directly — no local build step required.

| Service | Image |
|---|---|
| `juicepassproxy` | `ghcr.io/aldarondo/claude-juicebox-juicepassproxy:latest` |
| `juicebox-mcp` | `ghcr.io/aldarondo/claude-juicebox-mcp:latest` |

### First deploy

```bash
# From the repo root (claude-juicebox/)
cp .env.example .env   # fill in JUICEBOX_HOST and any overrides
docker compose pull
docker compose up -d
```

### Updating to latest images

```bash
docker compose pull
docker compose up -d
```

GitHub Actions builds and deploys automatically — no manual pull needed:
- `juicepassproxy` — on push to `juicepassproxy/Dockerfile`, and weekly Sundays at 2:00am UTC; SSHes into NAS to pull and restart after build
- `juicebox-mcp` — on push to `mcp-server/`, and weekly Sundays at 3:00am UTC; SSHes into NAS to pull and restart after build

**Required GitHub secret:** `NAS_SSH_PASSWORD` — add at `github.com/aldarondo/claude-juicebox/settings/secrets/actions`.

### GHCR authentication (private repo)

The NAS must be logged in to GHCR to pull the images. One-time setup — see the Synology skill documentation for the full command using the stored PAT.

The `PORT` variable in your `.env` controls which host port the MCP server binds to (default `3001`).

---

## Connecting Claude Desktop

### 1. Find your config file

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Create the file if it doesn't exist.

### 2. Add the MCP server entry

```json
{
  "mcpServers": {
    "juicebox": {
      "url": "http://<YOUR-NAS-IP>:3001/sse"
    }
  }
}
```

Replace `<YOUR-NAS-IP>` with your NAS/Docker host IP, and `3001` with your `PORT` value if you changed it. If you already have other MCP servers configured, add the `"juicebox"` key inside the existing `"mcpServers"` object.

### 3. Restart Claude Desktop

Fully quit and relaunch Claude Desktop. On the next launch it will connect to the SSE endpoint and register the JuiceBox tools.

### 4. Verify the connection

Ask Claude Desktop: **"What is my JuiceBox charger status?"**

Claude should call `get_charger_status` and return live data. If the tool list doesn't appear, check:

- The Docker stack is running: `docker compose ps` (from repo root)
- The SSE endpoint responds: `curl http://<YOUR-NAS-IP>:3001/health`
- No firewall is blocking port 3001 between your Mac/PC and the NAS

### Example prompts

Once connected, you can use natural language to control the charger from any Claude Desktop conversation:

```
Is my car charging?
Stop charging — we're at peak rate.
Start charging at 16 amps.
Set charging to run weeknights from 10pm to 6am at 32A.
What was the energy delivered in today's session?
Show me the current charging schedule.
Run diagnostics on the JuiceBox.
```

---

## Available tools

| Tool | Description |
|---|---|
| `get_charger_status` | Returns current state (charging/available/plugged/error), power (W), current (A), voltage (V), temperature (°F), and MQTT connection status |
| `get_session_info` | Returns energy delivered (kWh), elapsed time (minutes), and session start time for the active charging session |
| `start_charging` | Enables charging immediately; optionally sets max current (6–40 A, default 32 A) |
| `stop_charging` | Stops / pauses charging immediately |
| `set_current_limit` | Adjusts maximum charging current mid-session (6–40 A) without stopping the session |
| `get_diagnostics` | Returns firmware version, WiFi signal strength (dBm), and MQTT connection status |
| `get_logs` | Returns recent log entries from the persistent log file (default 200 lines, max 2000); survives container replacement |
| `get_charging_schedule` | Returns the currently programmed weekly charging schedule |
| `set_charging_schedule` | Programs a weekly schedule of charging windows (days + start/end time + max amps); pass an empty array to clear all scheduled charging |

### Scheduling example

`set_charging_schedule` is designed for use by an Enphase coordinator agent that fetches TOU (time-of-use) rates and battery state-of-charge, then programs the cheapest/cleanest charging windows:

```json
{
  "schedule": [
    {
      "label": "Weekday off-peak",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "start": "22:00",
      "end": "06:00",
      "max_amps": 32
    },
    {
      "label": "Weekend solar window",
      "days": ["sat", "sun"],
      "start": "10:00",
      "end": "14:00",
      "max_amps": 24
    }
  ]
}
```

Times are in 24-hour format, `America/Phoenix` timezone. Calling `set_charging_schedule` replaces the entire previous schedule atomically.

---

## Logging

All `console.log` and `console.error` output is written to both stdout and a persistent log file at `/logs/mcp.log` inside the container. The `mcp-logs` named Docker volume backs this path, so logs survive container replacement on redeploy.

- **Rotation:** when `mcp.log` exceeds 500 KB it is renamed to `mcp.log.1` and a fresh file begins.
- **Format:** `[ISO-8601 timestamp] INFO|ERROR  <message>`
- **Override path:** set `LOG_FILE` env var to change the log file path (useful for local dev).
- **Access via MCP:** call `get_logs` (optionally passing `lines: N`) to retrieve recent entries without shelling into the container.
- **Access via shell:** `docker exec juicebox-mcp tail -f /logs/mcp.log`

---

## Architecture note

```
JuiceBox Pro 40  <--UDP-->  JuicePassProxy  <--MQTT-->  Mosquitto  <--MQTT-->  This server  <--SSE-->  Claude Desktop
                                                                                     ^
                                                                                     |  SSE (set_charging_schedule)
                                                                              enphase-juicebox-coordinator
                                                                                     |
                                                                              Enphase Enlighten API
                                                                              (TOU tariff, solar SOC)
```

All three backend services (Mosquitto, JuicePassProxy, this MCP server) are defined in the root `docker-compose.yml` and run on the Synology NAS. This `mcp-server/` directory is only the MCP layer.

The **enphase-juicebox-coordinator** is a separate service that fetches TOU rates and battery state from the Enphase Enlighten API, computes optimal charging windows via `optimizer.py`, and pushes the result to this server via `set_charging_schedule` over the same SSE MCP interface that Claude Desktop uses.
