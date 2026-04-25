# Synology NAS Setup Guide

Deploy the full JuiceBox stack (dnsmasq DNS/DHCP, Mosquitto, JuicePassProxy, MCP server) on your Synology NAS.

---

## Architecture overview

```
JuiceBox Pro 40
    │
    │  UDP telemetry → resolves device-backend-udp-evos.juice.net via juicebox-dns → NAS
    ▼
NAS : <LOCAL_IP> : 8042
    │
    │  JuicePassProxy — reads packets, publishes to MQTT, forwards to real Enel X
    ▼
Mosquitto (localhost:1883)
    │
    ▼
juicebox-mcp ──SSE──► Claude Desktop
```

The key insight: instead of using JPP's `UPDATE_UDPC=true` mode (which crashes on this firmware), a local dnsmasq instance intercepts the charger's DNS query for `device-backend-udp-evos.juice.net` and returns the NAS IP. The charger sends UDP to the NAS without any telnet manipulation.

---

## Prerequisites

- Synology NAS with Docker / Container Manager installed (via Package Center)
- SSH access to the NAS (port 2222)
- JuiceBox on the same LAN as the NAS
- Ports `53/udp`, `67/udp`, `1883/tcp`, `3001/tcp`, `8042/udp` free on the NAS

Check ports via SSH:
```bash
sudo netstat -tulnp | grep -E ':53|:67|:1883|:3001|:8042'
```

---

## Step 1 — One-time NAS prep

### GHCR login (pull pre-built images)

```bash
echo <YOUR-GITHUB-PAT> | docker login ghcr.io -u <YOUR-GITHUB-USER> --password-stdin
```

The PAT needs `read:packages` scope. This persists in `~/.docker/config.json` — only needed once.

### NOPASSWD sudo for docker (needed by GitHub Actions deploy)

```bash
echo "charles ALL=(ALL) NOPASSWD: /usr/local/bin/docker" | sudo tee /etc/sudoers.d/charles-docker
chmod 0440 /etc/sudoers.d/charles-docker
```

See [nas-deploy-key-setup.md](nas-deploy-key-setup.md) for full CI key setup.

---

## Step 2 — Clone and configure

SSH into the NAS:

```bash
cd /volume1/docker
git clone https://github.com/aldarondo/claude-juicebox
cd claude-juicebox
cp .env.example .env
nano .env
```

Set these values (everything else can stay at the defaults):

```bash
LOCAL_IP=<NAS-LAN-IP>          # e.g. 192.168.0.64 — binds dnsmasq, JPP, and MCP
JUICEBOX_IP=<CHARGER-IP>       # e.g. 192.168.0.2  — what dnsmasq will assign via DHCP
GATEWAY_IP=<ROUTER-IP>         # e.g. 192.168.0.1  — handed to charger as default gateway
JUICEBOX_HOST=<CHARGER-IP>     # same as JUICEBOX_IP — used by zentriosClient HTTP calls
```

> `LOCAL_IP` must be the NAS's LAN interface IP — not a VPN or loopback address. Check with `ip addr show eth0` or `ip route get 8.8.8.8`.

---

## Step 3 — Cox router DHCP adjustment (one-time)

The charger uses DHCP. dnsmasq needs to win the DHCP race so it can hand the charger our NAS IP as its DNS server. Do this before starting the stack.

Browse to your router's admin page (`http://<ROUTER-IP>`) → **Gateway → Connection → Local IP Network**.

1. **DHCP Starting Address** → change to `.3` (removes `.2` from Cox's pool)
2. **DHCP Ending Address** → temporarily set to `.196`

Save Settings. This forces the charger off any Cox-held lease via DHCPNAK, making it fall back to a fresh DHCPDISCOVER that dnsmasq wins.

After the charger is stable at `.2`, the ending address restriction no longer matters — Cox can never offer `.2` (starts at `.3`), so dnsmasq always wins on every reboot. You can restore the ending address to `.253`.

> **MAC note:** dnsmasq is configured to respond only to the charger's **Wi-Fi MAC** (`52:D4:F7:14:50:E8`), not the hardware/ZentriOS MAC (`4C:55:CC:14:50:E8`). The Wi-Fi MAC is what appears in DHCP frames. If you have a different charger, get the right MAC from `docker logs juicebox-dns` after the first DHCP broadcast.

---

## Step 4 — Start the stack

```bash
docker compose pull
docker compose up -d
```

Verify all four containers are running:

```bash
docker compose ps
```

Expected:

```
NAME                  STATUS
juicebox-dns          Up (healthy)
juicebox-mosquitto    Up (healthy)
juicepassproxy        Up (healthy)
juicebox-mcp          Up (healthy)
```

---

## Step 5 — Reboot the charger

The charger needs to pick up its DHCP lease from dnsmasq (not Cox). Unplug the charger from power for 10 seconds and plug it back in, or use the ZentriOS HTTP API:

```bash
curl "http://<CHARGER-IP>/command/reboot"
```

After ~30 seconds, verify the charger got the right DNS:

```bash
# Check dnsmasq handed out the lease
docker logs juicebox-dns | grep -i dhcp

# Confirm DNS resolution is working — should resolve to NAS IP
docker exec juicepassproxy python3 -c "import socket; print(socket.gethostbyname('device-backend-udp-evos.juice.net'))"
# Expected: <LOCAL_IP>
```

---

## Step 6 — Verify telemetry

Plug in the car (the charger only sends UDP telemetry when a vehicle is connected — it's silent in standby):

```bash
# Watch MQTT topics — should see values arrive within ~30s of plugging in
docker exec -it juicebox-mosquitto mosquitto_sub -t 'hmd/#' -v
```

Expected output:
```
hmd/sensor/JuiceBox/Status/state Plugged In
hmd/sensor/JuiceBox/Voltage/state 240.0
hmd/sensor/JuiceBox/Current/state 0.0
...
```

---

## Step 7 — Connect Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "juicebox": {
      "type": "sse",
      "url": "http://<LOCAL_IP>:3001/sse"
    }
  }
}
```

Restart Claude Desktop. Test: *"What is the status of my JuiceBox charger?"*

---

## Step 8 — Health check

```bash
curl http://<LOCAL_IP>:3001/health
# {"ok":true,"mqtt_connected":true,"schedule_jobs":0,"schedule_paused":false}
```

`mqtt_connected: true` confirms the MCP server is receiving charger state.

---

## Useful commands

| Command | Purpose |
|---------|---------|
| `docker compose up -d` | Start all containers |
| `docker compose down` | Stop all containers |
| `docker compose ps` | Status of all containers |
| `docker compose pull && docker compose up -d` | Pull latest images and restart |
| `docker logs -f juicepassproxy` | Watch JPP proxy logs |
| `docker logs -f juicebox-mcp` | Watch MCP server logs |
| `docker logs juicebox-dns` | Check dnsmasq DHCP/DNS activity |
| `docker exec -it juicebox-mosquitto mosquitto_sub -t 'hmd/#' -v` | Inspect all MQTT traffic |

---

## Troubleshooting

### Charger not getting DNS from dnsmasq

Check dnsmasq logs for the charger's MAC:
```bash
docker logs juicebox-dns | grep -i "52:d4:f7"
```

If no entry: the charger hasn't sent a DHCP request yet. Reboot the charger. If it has sent one and dnsmasq didn't respond, confirm `JUICEBOX_IP` is inside the dnsmasq range and the Wi-Fi MAC matches.

### No MQTT data after car is plugged in

```bash
# Is JPP receiving UDP from the charger?
docker logs juicepassproxy --tail 30

# Is the DNS resolving correctly inside JPP's container?
docker exec juicepassproxy python3 -c "import socket; print(socket.gethostbyname('device-backend-udp-evos.juice.net'))"
```

If DNS resolves to the real Enel X IP instead of `LOCAL_IP`, the charger is still using Cox DNS — it hasn't picked up the dnsmasq lease yet. Reboot the charger again after confirming dnsmasq is running.

### juicepassproxy restarts every ~10 minutes when car is unplugged

Expected behavior. JPP's MITM times out after `MITM_RECV_TIMEOUT` seconds (default 600) with no UDP packets, then reconnects. Docker restarts it immediately. No action needed — it resumes as soon as the car is plugged in and telemetry flows.

### Container shows `unhealthy`

```bash
docker inspect juicebox-mcp | jq '.[0].State.Health'
```

Common causes:
- `juicebox-mcp` unhealthy → MCP server isn't responding on port 3001. Check `docker logs juicebox-mcp --tail 50`.
- `juicepassproxy` unhealthy → debug port not open. Check `docker logs juicepassproxy --tail 50`.

---

## Reverting to Enel X direct

To undo the DNS override and restore direct cloud connectivity:

```bash
# Stop dnsmasq so it no longer intercepts DNS/DHCP
docker compose stop juicebox-dns

# Re-enable DHCP on the charger so it gets Cox DNS
curl "http://<CHARGER-IP>/command/set%20wlan.dhcp.enabled%201"
curl "http://<CHARGER-IP>/command/save"
curl "http://<CHARGER-IP>/command/reboot"
```

After reboot, the charger will get Cox DNS and send UDP directly to the real Enel X server.
