# Synology NAS Setup Guide

Deploy the full JuiceBox stack (JuicePassProxy + Mosquitto + MCP server) on your Synology NAS at `<YOUR-NAS-IP>`.

---

## Prerequisites

- Docker and Docker Compose installed on the NAS (via Package Center → Container Manager)
- SSH access to the NAS
- JuiceBox Pro 40 reachable at `<YOUR-JUICEBOX-IP>`
- Ports `8042/udp` and `3001/tcp` free on the NAS

Check ports via SSH:
```bash
sudo netstat -tulnp | grep -E ':8042|:3001'
```
No output = both free.

---

## Step 1 — Clone the repo

SSH into the NAS and clone to a shared folder:

```bash
cd /volume1/docker        # or your preferred shared folder
git clone https://github.com/aldarondo/claude-juicebox
cd claude-juicebox
```

---

## Step 2 — Configure .env

```bash
cp .env.example .env
nano .env
```

Set at minimum:
```
JUICEBOX_HOST=<YOUR-JUICEBOX-IP>
JUICEBOX_ID=JuiceBox-0E8
```

Leave everything else as-is for the first run.

---

## Step 3 — First-time UDPC update

This one-time step redirects the JuiceBox's UDP traffic from the Enel X cloud to your NAS.

In `.env`, set:
```
UPDATE_UDPC=true
```

Then start the stack:
```bash
docker-compose up -d
```

Watch the JuicePassProxy logs until you see the UDPC update succeed:
```bash
docker logs -f juicepassproxy
```

Look for a line like `UDPC updated` or `telnet success`. Once confirmed, stop following logs (`Ctrl+C`).

---

## Step 4 — Disable UDPC update

In `.env`, set:
```
UPDATE_UDPC=false
```

Restart JuicePassProxy so it no longer tries to telnet in:
```bash
docker-compose restart juicepassproxy
```

The JuiceBox now permanently points at your NAS — it will survive charger reboots.

---

## Step 5 — Verify MQTT data

Check that JuicePassProxy is forwarding charger state to Mosquitto:
```bash
docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v
```

You should see JSON messages arriving every ~30 seconds that look like:
```
juicebox/JuiceBox-0E8/state {"state":"available","amps":0,"voltage":240,...}
```

**If the topic names differ from `juicebox/JuiceBox-0E8/state`**, set the correct names in `.env`:
```
MQTT_STATE_TOPIC=actual/topic/name/from/above
MQTT_CMD_TOPIC=actual/topic/name/cmd
```
Then restart the MCP container: `docker-compose restart juicebox-mcp`

---

## Step 6 — Add MCP server to Claude

In Claude Code settings, add a new MCP server:
```
http://<YOUR-NAS-IP>:3001/sse
```
(Change `3001` if you set a different `MCP_PORT`.)

Test it by asking Claude: *"What is the status of my JuiceBox charger?"*

---

## Step 7 — Health check

```bash
curl http://<YOUR-NAS-IP>:3001/health
# {"ok":true,"mqtt_connected":true,"schedule_jobs":0}
```

`mqtt_connected: true` confirms the MCP server is receiving charger state.

---

## Useful commands

| Command | Purpose |
|---------|---------|
| `docker-compose up -d` | Start all containers |
| `docker-compose down` | Stop all containers |
| `docker-compose restart juicebox-mcp` | Restart MCP server only |
| `docker logs -f juicepassproxy` | Watch proxy logs |
| `docker logs -f juicebox-mcp` | Watch MCP server logs |
| `docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v` | Inspect all MQTT traffic |
| `docker-compose pull && docker-compose up -d` | Update all images |

---

## Reverting the UDPC change

If you ever want to point the JuiceBox back at the Enel X cloud:

```bash
telnet <YOUR-JUICEBOX-IP>
set udpc juicenet-udp-prod3-usa.enelx.com:8042
save
reboot
```
