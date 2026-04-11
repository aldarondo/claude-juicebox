/**
 * MQTT client for JuicePassProxy.
 *
 * Reads charger state by subscribing to the topic JuicePassProxy publishes to.
 * Sends charger commands by publishing to the topic JuicePassProxy subscribes to.
 *
 * If the default topic names don't match what your JuicePassProxy version uses,
 * set MQTT_STATE_TOPIC and MQTT_CMD_TOPIC in .env. To find the real topic names:
 *
 *   docker exec -it juicebox-mosquitto mosquitto_sub -t '#' -v
 *
 * The state payload is expected to be JSON. Common field names from JuicePassProxy:
 *   state, amps/current, voltage, watts/power, watt_hours_session/energy_session,
 *   temperature, signal, firmware_version
 *
 * For the command format, JuicePassProxy (juicerescue) accepts:
 *   { "command": "override_start", "amps": 32 }  — start charging at given amps
 *   { "command": "override_stop" }               — stop charging
 *   { "command": "set_current", "amps": 24 }     — adjust current mid-session
 *
 * If your JuicePassProxy version doesn't support MQTT commands, control can be
 * implemented via direct UDP to the JuiceBox — open an issue on the repo.
 */

import mqtt from "mqtt";

const BROKER = process.env.MQTT_BROKER || "mqtt://localhost:1883";
const DEVICE  = process.env.JUICEBOX_ID || "JuiceBox-0E8";

const STATE_TOPIC = process.env.MQTT_STATE_TOPIC || `juicebox/${DEVICE}/state`;
const CMD_TOPIC   = process.env.MQTT_CMD_TOPIC   || `juicebox/${DEVICE}/cmd`;

let mqttClient  = null;
let lastState   = null;   // most recent parsed state message
let sessionStart = null;  // wall-clock time when charging was first detected

function buildConnectOptions() {
  const opts = { reconnectPeriod: 5000, connectTimeout: 10_000 };
  const user = process.env.MQTT_USER;
  const pass = process.env.MQTT_PASS;
  if (user) { opts.username = user; opts.password = pass; }
  return opts;
}

function normalise(raw) {
  // JuicePassProxy field names vary by version — normalise to a consistent shape.
  return {
    state:               raw.state ?? null,
    current_a:           raw.amps   ?? raw.current ?? null,
    voltage_v:           raw.voltage ?? null,
    power_w:             raw.watts  ?? raw.power   ?? null,
    session_energy_wh:   raw.watt_hours_session ?? raw.energy_session ?? null,
    temperature_c:       raw.temperature ?? null,
    signal_dbm:          raw.signal ?? null,
    firmware_version:    raw.firmware_version ?? raw.firmware ?? null,
    _raw: raw,
  };
}

export function connect() {
  mqttClient = mqtt.connect(BROKER, buildConnectOptions());

  mqttClient.on("connect", () => {
    console.log(`[juicebox] Connected to MQTT at ${BROKER}`);
    mqttClient.subscribe(STATE_TOPIC, { qos: 1 }, (err) => {
      if (err) console.error("[juicebox] Subscribe error:", err.message);
      else     console.log(`[juicebox] Subscribed to ${STATE_TOPIC}`);
    });
  });

  mqttClient.on("message", (_topic, payload) => {
    try {
      const raw  = JSON.parse(payload.toString());
      const prev = lastState;
      lastState  = normalise(raw);

      if (lastState.state === "charging" && prev?.state !== "charging") {
        sessionStart = new Date();
      } else if (lastState.state !== "charging") {
        sessionStart = null;
      }
    } catch (e) {
      console.warn("[juicebox] Failed to parse state message:", e.message);
    }
  });

  mqttClient.on("error",     (e) => console.error("[juicebox] MQTT error:", e.message));
  mqttClient.on("reconnect", ()  => console.log("[juicebox] Reconnecting to MQTT…"));
  mqttClient.on("offline",   ()  => console.log("[juicebox] MQTT client offline"));
}

function publish(payload) {
  if (!mqttClient?.connected) {
    throw new Error("MQTT client not connected — charger commands unavailable");
  }
  mqttClient.publish(CMD_TOPIC, JSON.stringify(payload), { qos: 1 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getState()        { return lastState; }
export function getSessionStart() { return sessionStart; }
export function isConnected()     { return mqttClient?.connected ?? false; }

export function startCharging(amps = 32) {
  if (amps < 6 || amps > 40) throw new RangeError("amps must be 6–40");
  publish({ command: "override_start", amps });
}

export function stopCharging() {
  publish({ command: "override_stop" });
}

export function setCurrentLimit(amps) {
  if (amps < 6 || amps > 40) throw new RangeError("amps must be 6–40");
  publish({ command: "set_current", amps });
}
