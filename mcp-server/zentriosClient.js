/**
 * ZentriOS client — talks to the JuiceBox Pro 40's built-in ZentriOS web API.
 *
 * Endpoint: http://<JUICEBOX_HOST>/command/<cmd>
 * Response: {"id":N,"code":0,"flags":0,"response":"..."}
 * code 0 = success, non-zero = error.
 *
 * Variables of interest (all get/set unless noted):
 *   wlan.ssid              — WiFi network name
 *   wlan.passkey           — WiFi password
 *   wlan.bssid             — Access point MAC
 *   wlan.mac               — Device WiFi MAC (get only)
 *   wlan.security          — Security type (e.g. wpa2_aes)
 *   wlan.dhcp.enabled      — DHCP on/off
 *   wlan.dhcp.hostname     — DHCP hostname
 *   wlan.network.ip        — Current IP (get only)
 *   wlan.network.gateway   — Current gateway (get only)
 *   wlan.network.dns       — Current DNS (get only)
 *   wlan.network.netmask   — Current netmask (get only)
 *   wlan.network.status    — Connection status string (get only)
 *   wlan.rssi_average      — RSSI averaging window
 *   wlan.static.ip         — Static IP (when DHCP disabled)
 *   wlan.static.gateway    — Static gateway
 *   wlan.static.netmask    — Static netmask
 *   wlan.static.dns        — Static DNS
 *   wlan.info              — Full WiFi summary (get only)
 *   wlan.join.result       — Last join result (get only)
 *   system.version         — Firmware build string (get only)
 *   system.uuid            — Device UUID (get only)
 *   system.build_number    — Git hash of firmware (get only)
 *   system.memory.usage    — Heap usage (get only)
 *   time.uptime            — Seconds since last boot (get only)
 *   time.rtc               — Current RTC time
 *   udp.client.remote_host — UDPC target host (JuicePassProxy / JuiceNet)
 *   udp.client.remote_port — UDPC target port
 *
 * Commands of interest:
 *   wlan_scan              — Scan for nearby WiFi networks
 *   wlan_get_rssi          — Current RSSI in dBm
 *   save                   — Persist settings to flash
 *   reboot                 — Reboot the device
 *   version                — Firmware version string
 *   ping <host>            — Ping a host
 *   network_lookup <host>  — DNS lookup
 */

import { get as httpGet } from "http";

const HOST    = process.env.JUICEBOX_HOST    || "192.168.0.2";
const TIMEOUT = parseInt(process.env.ZENTRIOS_TIMEOUT || "5000", 10);

/**
 * Run a ZentriOS command via the HTTP API.
 * Returns the parsed response string on success, throws on error.
 */
export async function runCommand(cmd) {
  const url = `http://${HOST}/command/${encodeURIComponent(cmd)}`;
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout: TIMEOUT }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.code !== 0) {
            reject(new Error(`ZentriOS error (code ${parsed.code}) for "${cmd}": ${parsed.response?.trim() || "(no response)"}`));
          } else {
            resolve(parsed.response?.trim() ?? "");
          }
        } catch {
          reject(new Error(`Failed to parse ZentriOS response for "${cmd}": ${body.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("ZentriOS request timed out")); });
    req.on("error", reject);
  });
}

/** Get a single variable. Returns the value string. */
export async function getVar(name) {
  const resp = await runCommand(`get ${name}`);
  const lines = resp.split(/\r?\n/);
  // First line is the echoed command, second is the value
  return (lines.length > 1 ? lines[1] : lines[0]).trim();
}

/** Set a variable. Does NOT auto-save — call save() separately. */
export async function setVar(name, value) {
  return runCommand(`set ${name} ${value}`);
}

/** Persist current settings to flash. */
export async function save() {
  return runCommand("save");
}

/** Reboot the device. */
export async function reboot() {
  return runCommand("reboot").catch(() => {
    // Reboot kills the HTTP connection — swallow the disconnect error.
  });
}

/** Fetch all WiFi + network state in one batch. */
export async function getWifiInfo() {
  const vars = [
    "wlan.ssid",
    "wlan.mac",
    "wlan.bssid",
    "wlan.security",
    "wlan.dhcp.enabled",
    "wlan.network.ip",
    "wlan.network.gateway",
    "wlan.network.dns",
    "wlan.network.netmask",
    "wlan.network.status",
    "wlan.join.result",
    "udp.client.remote_host",
    "udp.client.remote_port",
  ];
  const results = {};
  await Promise.allSettled(
    vars.map(async (v) => {
      try { results[v] = await getVar(v); }
      catch (e) { results[v] = `error: ${e.message}`; }
    })
  );
  return results;
}

/** Fetch system info. */
export async function getSystemInfo() {
  const vars = ["system.version", "system.uuid", "system.build_number", "system.memory.usage", "time.uptime"];
  const results = {};
  await Promise.allSettled(
    vars.map(async (v) => {
      try { results[v] = await getVar(v); }
      catch (e) { results[v] = `error: ${e.message}`; }
    })
  );
  return results;
}

/** Scan for nearby WiFi networks. Returns raw scan output. */
export async function wifiScan() {
  return runCommand("wlan_scan");
}

/** Get current RSSI in dBm. */
export async function getRssi() {
  return runCommand("wlan_get_rssi");
}
