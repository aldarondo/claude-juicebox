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
| `JUICEBOX_ID` | `JuiceBox-0E8` | Device ID used to build default topic names |
| `MQTT_STATE_TOPIC` | `juicebox/<JUICEBOX_ID>/state` | Override if JuicePassProxy uses a different topic |
| `MQTT_CMD_TOPIC` | `juicebox/<JUICEBOX_ID>/cmd` | Override if JuicePassProxy uses a different topic |
| `MQTT_USER` | _(none)_ | MQTT username (if broker requires auth) |
| `MQTT_PASS` | _(none)_ | MQTT password (if broker requires auth) |

To discover the actual topic names your JuicePassProxy version publishes:

```bash
docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v
```

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

The full stack — Mosquitto, JuicePassProxy, and this MCP server — is wired together by the **root `docker-compose.yml`** one level up:

```bash
# From the repo root (claude-juicebox/)
cp .env.example .env   # if one exists, or create your own
docker compose up -d
```

The `PORT` variable in your `.env` controls which host port the MCP server binds to (default `3001`). Both the host-side port mapping and the `PORT` env var inside the container use the same value, so you only need to set it once.

---

## Connecting Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "juicebox": {
      "url": "http://<your-host-ip>:3001/sse"
    }
  }
}
```

Replace `<your-host-ip>` with the IP of the machine running Docker (e.g. `192.168.0.64`), and `3001` with your `PORT` value if you changed it.

---

## Available tools

| Tool | Description |
|---|---|
| `get_charger_status` | Returns current state (charging/available/plugged/error), power (W), current (A), voltage (V), temperature (°C), and MQTT connection status |
| `get_session_info` | Returns energy delivered (kWh), elapsed time (minutes), and session start time for the active charging session |
| `start_charging` | Enables charging immediately; optionally sets max current (6–40 A, default 32 A) |
| `stop_charging` | Stops / pauses charging immediately |
| `set_current_limit` | Adjusts maximum charging current mid-session (6–40 A) without stopping the session |
| `get_diagnostics` | Returns firmware version, WiFi signal strength (dBm), and MQTT connection status |
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

## Architecture note

```
JuiceBox Pro 40  <--UDP-->  JuicePassProxy  <--MQTT-->  Mosquitto  <--MQTT-->  This server  <--SSE-->  Claude
```

All three backend services (Mosquitto, JuicePassProxy, this server) are defined in the root `docker-compose.yml`. This `mcp-server/` directory is only the MCP layer.
