# claude-juicebox

Docker Compose stack that lets Claude monitor and control a **JuiceBox Pro 40 EV charger**.

Three services run together:
- **Mosquitto** — local MQTT broker
- **JuicePassProxy (JPP)** — intercepts the charger's UDP telemetry stream and republishes it to MQTT
- **juicebox-mcp** — MCP server that exposes charger tools to Claude Desktop over SSE
- **juicebox-dns** — dnsmasq instance that redirects the charger's Enel X DNS query to this NAS (see [DNS approach](#dns-approach))

---

## Architecture

```
JuiceBox Pro 40
    │
    │  UDP telemetry (every ~26s when active)
    │  ──► resolves device-backend-udp-evos.juice.net → NAS (via juicebox-dns)
    ▼
NAS : <YOUR-NAS-IP> : 8042
    │
    │  JuicePassProxy (MITM)
    │  reads packets, publishes to MQTT, forwards originals to real Enel X
    ▼
Mosquitto (localhost:1883)
    │
    │  hmd/sensor/JuiceBox/*/state topics
    ▼
juicebox-mcp  ──SSE──►  Claude Desktop
```

The JuiceBox also maintains an HTTPS connection to `device-backend-evos.juice.net:443` for cloud management. That connection is **not** intercepted — only the UDP data stream is proxied.

---

## Protocol deep-dive

### How the JuiceBox sends data

The JuiceBox uses two network channels simultaneously:

| Channel | Host | Port | Purpose |
|---------|------|------|---------|
| HTTPS (TCP) | `device-backend-evos.juice.net` | 443 | Cloud management, OTA updates, push config |
| UDP (UDPC) | `device-backend-udp-evos.juice.net` | 8042 | Real-time telemetry (power, current, voltage, status) |

JPP intercepts **UDP only**. The HTTPS management channel is untouched — the Enel X app, OTA updates, and remote management all continue to work.

### UDPC (UDP Client)

The JuiceBox has a telnet interface (port 2000) that lists and manages its active UDP streams:

```
> list
! # Type  Info
# 0 UDPC  device-backend-udp-evos.juice.net:8042 (52733)
```

When the DNS override is in place, this hostname resolves to the NAS (`<YOUR-NAS-IP>`). The charger sends its UDP telemetry to `<YOUR-NAS-IP>:8042`, JPP intercepts it, and forwards it on to the real Enel X IP.

### MQTT topic structure (JPP v0.5.x)

JuicePassProxy v0.5.x publishes per-field topics under the `hmd/` namespace (Home Assistant MQTT Discovery format):

| Topic | Example value |
|-------|---------------|
| `hmd/sensor/JuiceBox/Status/state` | `Charging` |
| `hmd/sensor/JuiceBox/Power/state` | `1248` |
| `hmd/sensor/JuiceBox/Current/state` | `5.2` |
| `hmd/sensor/JuiceBox/Voltage/state` | `240` |
| `hmd/sensor/JuiceBox/Temperature/state` | `72.5` |
| `hmd/sensor/JuiceBox/Energy--Session-/state` | `3.4` |
| `hmd/sensor/JuiceBox/Energy--Lifetime-/state` | `1482.3` |
| `hmd/number/JuiceBox/Max-Current-Online-Wanted-/state` | `32` |

Commands are published to:
```
hmd/number/JuiceBox/Max-Current-Online-Wanted-/command   # set amperage (0 = stop)
```

> **Note:** Earlier JPP versions (pre-0.5) used a single JSON blob at `juicebox/<ID>/state`. If you see no data, run `docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v` to inspect actual topics and update `MQTT_STATE_TOPIC` / `MQTT_CMD_TOPIC` in `.env`.

### When does the charger send UDP?

The charger only sends directed UDP telemetry when **a car is plugged in**. In standby (no car), it only broadcasts a discovery packet to `255.255.255.255:55555` every 10 seconds containing WiFi and firmware info — not charging data.

This means:

- JuicePassProxy will log `No Message Received after 120 sec` warnings when the charger is idle. This is expected — not a bug.
- The MITM reconnects after each timeout and accumulates errors. After ~10 errors (20 min of idle), JPP internally restarts its loop. After 10 loop restarts (~3.3 hours), the container process exits and Docker immediately restarts it via `restart: unless-stopped`.
- When the car is plugged in, telemetry resumes immediately. No action needed.

---

## DNS approach

### Why not `UPDATE_UDPC=true`?

JPP's `UPDATE_UDPC=true` mode uses telnet to check and update the UDPC setting every 30 seconds. On this charger's EMWERK firmware, the telnet `list` command response format causes JPP's `readuntil` to time out on every check. Each timeout counts as an error; after 10 errors in 60 minutes, JPP crashes.

`UPDATE_UDPC=true` is therefore disabled (`UPDATE_UDPC=false` in `.env`).

### The DNS override

Instead of fighting the UDPC telnet interface, we make the charger's DNS resolution do the work:

1. **`juicebox-dns`** (dnsmasq) runs on the NAS and listens on port 53.
2. It resolves `device-backend-udp-evos.juice.net` → `<YOUR-NAS-IP>` (NAS IP).
3. It forwards all other queries to `8.8.8.8` normally.
4. The JuiceBox must be configured to use `<YOUR-NAS-IP>` as its DNS server (see below).

When the Enel X cloud management channel pushes a new UDPC config (`device-backend-udp-evos.juice.net:8042`), the charger resolves that hostname through our dnsmasq and sends UDP to `<YOUR-NAS-IP>:8042` instead of the real Enel X server.

JPP then receives the packet and forwards it to the real `158.47.3.128:8042`.

### Getting the JuiceBox to use our DNS

The JuiceBox uses DHCP (`wlan.dhcp.enabled` reverts to `1` after reboot on EMWERK firmware — see [troubleshooting](#wlandhcpenabled-reverts-to-1-after-charger-reboot)). The solution is to make dnsmasq also serve as the DHCP server for the JuiceBox, handing it `<YOUR-NAS-IP>` as its DNS server via the DHCP lease itself.

#### How it works

`juicebox-dns` (dnsmasq) runs in **host network mode** so it can receive DHCP broadcasts. It is configured to:

- **Only respond to the JuiceBox Wi-Fi MAC** (`52:D4:F7:14:50:E8`) — all other DHCP requests are silently ignored
- **Assign** `<YOUR-JUICEBOX-IP>` with DNS `<YOUR-NAS-IP>` and gateway `<YOUR-ROUTER-IP>`
- **Ignore** all other MACs (`dhcp-ignore=tag:!known`) — the Cox router continues to handle DHCP for all other devices

> **MAC note:** The JuiceBox has two MACs. The hardware/ZentriOS MAC (`4C:55:CC:14:50:E8`) appears in `get network.mac` via telnet. The Wi-Fi interface MAC (`52:D4:F7:14:50:E8`) is what the charger actually uses in DHCP frames. `dhcp-host` **must** use the Wi-Fi MAC or dnsmasq will silently ignore all JuiceBox DHCP requests.

To eliminate the race condition between dnsmasq and the Cox router, the Cox DHCP range must be shrunk so that `.2` and the JuiceBox's previously-held IP are both outside it. The charger broadcasts a DHCPREQUEST for its last known IP on reboot:
- Cox rejects it (outside its range) → Cox sends DHCPNAK
- dnsmasq rejects it too (wants to assign `.2`) → dnsmasq sends DHCPNAK
- JuiceBox gets DHCPNAK, falls back to fresh DHCPDISCOVER
- dnsmasq offers `.2`; Cox offers something from its range; JuiceBox accepts first offer
- Once JuiceBox holds `.2`, it requests `.2` on every subsequent reboot; Cox always rejects (`.2` outside its range); dnsmasq always wins — stable permanently

#### One-time Cox router changes

Browse to `http://<YOUR-ROUTER-IP>` → **Gateway → Connection → Local IP Network**.

1. Change **DHCP Starting Address** from `<YOUR-JUICEBOX-IP>` → `<YOUR-DHCP-START>` (removes `.2` from Cox's pool permanently)
2. Change **DHCP Ending Address** to end below any IP the JuiceBox might currently hold — in practice `.196` works well

Save Settings. After the JuiceBox is stable at `.2`, the ending address restriction matters less (Cox can't offer `.2` regardless since it starts at `.3`).

### Why the NAS itself isn't affected

The NAS (Synology DSM) and all Docker containers use their own DNS (configured via DSM network settings, typically the Cox gateway). Only the JuiceBox — the sole device dnsmasq serves DHCP to — is affected. JPP's own DNS lookups for the Enel X IP go through the NAS's upstream DNS and return the real IP.

### Cox router note

Cox Panoramic's Local IP Configuration page does not expose a DNS server field in DHCP settings — it always hands out the router itself (`<YOUR-ROUTER-IP>`) as DNS. The dnsmasq DHCP approach sidesteps this entirely by having dnsmasq serve the JuiceBox directly.

---

## Deployment

### Prerequisites

- Synology NAS at `<YOUR-NAS-IP>` with Docker / Container Manager
- JuiceBox at `<YOUR-JUICEBOX-IP>` on the same LAN
- Port `53` (DNS), `67` (DHCP), `1883` (MQTT), `3001` (MCP), `8042` (JPP) free on the NAS
- SSH access + a GitHub deploy key (see `claude-synology` skill for setup)

### Deploy to NAS

```bash
# From the claude-synology directory on your dev machine:
python skills/synology.py deploy git@github-claude-juicebox:aldarondo/claude-juicebox.git /volume1/docker/claude-juicebox
```

This clones the repo, bootstraps `.env` from `.env.example`, and runs `docker compose up -d`.

### Update an existing deployment

```bash
python skills/synology.py deploy /volume1/docker/claude-juicebox --update
```

### Configure the JuiceBox for static DNS

> **Note:** On this EMWERK firmware, `wlan.dhcp.enabled 0` reverts to `1` after reboot, likely due to the Enel X cloud management channel resetting it. The static settings (`wlan.static.dns`, IP, gateway, netmask) **do** persist. Consider using Option A (Cox DHCP) instead — see [Getting the JuiceBox to use our DNS](#getting-the-juicebox-to-use-our-dns).

The charger's WiFi config can be set to static networking so it uses the NAS as its DNS server. Even if DHCP re-enables on reboot, the `wlan.static.*` values remain saved for reference or retry.

Connect via the charger's telnet interface (port 2000) and run:

```
set wlan.static.ip <YOUR-JUICEBOX-IP>
set wlan.static.gateway <YOUR-ROUTER-IP>
set wlan.static.netmask 255.255.255.0
set wlan.static.dns <YOUR-NAS-IP>
set wlan.dhcp.enabled 0
save
reboot
```

> **Important:** Do this **after** `juicebox-dns` is running. If the NAS DNS container is down when the charger boots, the charger won't be able to resolve any hostnames.

To run these commands from the NAS (requires juicepassproxy container to already be running):

```bash
docker exec juicepassproxy python3 - <<'EOF'
import asyncio, telnetlib3

async def configure():
    reader, writer = await asyncio.wait_for(
        telnetlib3.open_connection('<YOUR-JUICEBOX-IP>', 2000, encoding=False), timeout=10)
    # wait for prompt
    data = b''
    while b'>' not in data:
        try: chunk = await asyncio.wait_for(reader.read(256), timeout=3.0); data += chunk
        except: break

    async def cmd(s):
        writer.write(b'\n')
        await asyncio.sleep(0.2)
        writer.write(s.encode() + b'\n')
        await writer.drain()
        import time; end = time.time() + 3; out = b''
        while time.time() < end:
            try: chunk = await asyncio.wait_for(reader.read(256), timeout=0.5); out += chunk
            except: pass
        print(f'{s!r} → {out.decode(errors="replace").strip()!r}')

    await cmd('set wlan.static.ip <YOUR-JUICEBOX-IP>')
    await cmd('set wlan.static.gateway <YOUR-ROUTER-IP>')
    await cmd('set wlan.static.netmask 255.255.255.0')
    await cmd('set wlan.static.dns <YOUR-NAS-IP>')
    await cmd('set wlan.dhcp.enabled 0')
    await cmd('save')
    await cmd('reboot')
    writer.close()

asyncio.run(configure())
EOF
```

### Verify

After the charger reboots (~30 seconds), check that it's using the NAS DNS and that telemetry is flowing:

```bash
# Check dnsmasq logs — you should see JuiceBox DNS queries
docker logs juicebox-dns | grep juicebox

# Listen for charger UDP on port 8042
sudo tcpdump -i any -n 'src host <YOUR-JUICEBOX-IP> and udp port 8042' -c 5

# Watch MQTT topics for charger data (requires car plugged in)
docker exec -it juicebox-mosquitto mosquitto_sub -t 'hmd/#' -v
```

---

## Charger firmware reference

The deployed charger runs **ZentriOS-WZ** (by Silicon Labs / Zentri) via the EMWERK JuiceBox firmware:

| Field | Value |
|-------|-------|
| Firmware | `EMWERK-JB_1_1-1.4.0.28` |
| OS | `ZentriOS-WZ-3.6.4.0` |
| MAC | `4C:55:CC:14:50:E8` |
| Telnet port | `2000` |
| HTTP port | `80` |
| UDP broadcast | `255.255.255.255:55555` (discovery, every 10s) |
| UDP telemetry | `device-backend-udp-evos.juice.net:8042` (when active) |
| Cloud management | `device-backend-evos.juice.net:443` (HTTPS, always) |

### Useful telnet commands

Connect: `telnet <YOUR-JUICEBOX-IP> 2000` (or use the docker exec script above)

| Command | Description |
|---------|-------------|
| `get all` | Dump all configuration variables |
| `get wlan` | WiFi and network config (IP, DNS, gateway) |
| `list` | Show active UDP streams (UDPC connections) |
| `udpc <host> <port>` | Add a UDPC stream |
| `stream_close <id>` | Close a UDPC stream by ID |
| `save` | Persist current config to flash |
| `reboot` | Reboot the charger |

### Why `UPDATE_UDPC=true` doesn't work reliably

JPP's UDPC updater connects via telnet and runs `list` to check the current UDPC destination. It then waits for the response using `readuntil(b"list\r\n! ")`. On this EMWERK firmware, the telnet `list` response doesn't arrive in a format JPP's readuntil can detect (possibly a telnet option negotiation issue). The result: every check times out, counts as an error, and after 10 errors in 60 minutes JPP crashes.

Workaround: the DNS override makes UDPC management unnecessary. The charger's cloud-managed UDPC resolves to our NAS automatically.

---

## Connecting Claude Desktop

Add to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "juicebox": {
      "type": "sse",
      "url": "http://<YOUR-NAS-IP>:3001/sse"
    }
  }
}
```

Restart Claude Desktop. Test: *"What is the status of my JuiceBox charger?"*

---

## Troubleshooting

### No MQTT data — car not plugged in

The charger only sends UDP telemetry when a car is connected. In standby it only broadcasts discovery packets on port 55555. Plug in the car and run:

```bash
docker exec -it juicebox-mosquitto mosquitto_sub -t 'hmd/#' -v
```

### juicepassproxy restarts every ~3.3 hours when idle

Expected behavior. The MITM times out after 120 seconds of no packets (one error), reconnects, and eventually JPP's internal loop counter hits its limit and the process exits. Docker restarts it immediately. No action needed — it's up within seconds.

When actively charging, no restarts occur.

### wlan.dhcp.enabled reverts to 1 after charger reboot

Observed on EMWERK-JB_1_1-1.4.0.28 firmware. Setting `wlan.dhcp.enabled 0` and `save` accepts the command, but after a reboot `get wlan` shows `wlan.dhcp.enabled: 1` again. The static IP/DNS/gateway/netmask settings **do** persist; only the DHCP-enabled flag reverts.

Root cause is likely the Enel X cloud management channel pushing the network config back on connect. The charger cannot be run without cloud access, so fighting this isn't practical.

**Workaround:** Use Option A — configure the Cox router to hand out `<YOUR-NAS-IP>` as the DHCP DNS server. The charger gets our dnsmasq via DHCP, no static config needed. See [Getting the JuiceBox to use our DNS](#getting-the-juicebox-to-use-our-dns).

### DNS not working after charger reboot

If `juicebox-dns` was down when the charger booted, its DHCP fallback may have kicked in (getting Cox DNS). Restart the container, then reboot the charger:

```bash
docker restart juicebox-dns
# wait 10 seconds
docker exec juicepassproxy python3 -c "
import asyncio, telnetlib3
async def r():
    rd, wr = await telnetlib3.open_connection('<YOUR-JUICEBOX-IP>', 2000, encoding=False)
    import time; e=time.time()+3; d=b''
    while time.time()<e:
        try: d+=await asyncio.wait_for(rd.read(256),0.5)
        except: pass
    wr.write(b'\nreboot\n'); await wr.drain()
asyncio.run(r())
"
```

### Check which DNS the charger is using

```bash
docker exec juicepassproxy python3 -c "
import asyncio, telnetlib3
async def check():
    r,w = await telnetlib3.open_connection('<YOUR-JUICEBOX-IP>',2000,encoding=False)
    import time; e=time.time()+3; d=b''
    while time.time()<e:
        try: d+=await asyncio.wait_for(r.read(256),0.5)
        except: pass
    w.write(b'\nget wlan.network.dns\n'); await w.drain()
    await asyncio.sleep(2)
    import time; e=time.time()+3; d=b''
    while time.time()<e:
        try: d+=await asyncio.wait_for(r.read(256),0.5)
        except: pass
    print(d.decode(errors='replace'))
asyncio.run(check())
"
```

Expected output: `wlan.network.dns: <YOUR-NAS-IP>` (static DNS, our NAS)

### MQTT topics don't match

JPP v0.5.x uses `hmd/sensor/JuiceBox/*/state` topics, not `juicebox/<ID>/state`. Run:

```bash
docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v
```

If topics are different, set `MQTT_STATE_TOPIC` and `MQTT_CMD_TOPIC` in `.env` and restart the MCP container.

### Revert the charger to Enel X direct (undo DNS override)

```bash
docker exec juicepassproxy python3 - <<'EOF'
import asyncio, telnetlib3
async def revert():
    r,w = await telnetlib3.open_connection('<YOUR-JUICEBOX-IP>',2000,encoding=False)
    import time; e=time.time()+3; d=b''
    while time.time()<e:
        try: d+=await asyncio.wait_for(r.read(256),0.5)
        except: pass
    for cmd in [b'set wlan.dhcp.enabled 1', b'save', b'reboot']:
        w.write(b'\n'); await asyncio.sleep(0.2)
        w.write(cmd+b'\n'); await w.drain()
        await asyncio.sleep(2)
asyncio.run(revert())
EOF
```

This re-enables DHCP. The charger will get Cox DNS on next boot and send telemetry directly to Enel X again.
