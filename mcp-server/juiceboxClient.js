/**
 * MQTT client for JuicePassProxy v0.5.x (HA-style topics).
 *
 * JuicePassProxy v0.5+ publishes each field as a separate MQTT topic:
 *   hmd/sensor/JuiceBox/<Field>/state  → string value
 *
 * Known state topics (subscribe to hmd/# to see all):
 *   hmd/sensor/JuiceBox/Status/state          → "Charging" | "Standby" | "Plugged In" | ...
 *   hmd/sensor/JuiceBox/Current/state         → amps (float string)
 *   hmd/sensor/JuiceBox/Voltage/state         → volts (float string)
 *   hmd/sensor/JuiceBox/Power/state           → watts (int string)
 *   hmd/sensor/JuiceBox/Temperature/state     → °F (float string)
 *   hmd/sensor/JuiceBox/Energy--Session-/state  → Wh (int string)
 *   hmd/sensor/JuiceBox/Energy--Lifetime-/state → Wh (int string)
 *   hmd/sensor/JuiceBox/Frequency/state       → Hz (float string)
 *   hmd/sensor/JuiceBox/Power-Factor/state    → (float string)
 *   hmd/sensor/JuiceBox/Current-Rating/state  → max amps (int string)
 *   hmd/number/JuiceBox/Max-Current-Online-Wanted-/state   → wanted amps (float string)
 *   hmd/number/JuiceBox/Max-Current-Offline-Wanted-/state  → wanted amps when offline (float string)
 *
 * Command topics:
 *   hmd/number/JuiceBox/Max-Current-Online-Wanted-/command   → set max amps (number)
 *   hmd/number/JuiceBox/Max-Current-Offline-Wanted-/command  → set offline max amps (number)
 *
 * To "stop" charging: set Max-Current-Online-Wanted- to 0 (or minimum 6A).
 * To "start" charging: restore to previous amps (default 32A).
 * JuicePassProxy v0.5.x does not expose an explicit start/stop command.
 */

import mqtt from "mqtt";

const BROKER  = process.env.MQTT_BROKER || "mqtt://localhost:1883";
const DEVICE  = "JuiceBox";  // JPP v0.5 uses the fixed name "JuiceBox" not the ID

// Topic prefix used by JuicePassProxy v0.5.x HA-discoverable topics
const HMD = "hmd";

let mqttClient   = null;
let state        = {};   // aggregated charger state from per-field topics
let sessionStart = null; // wall-clock time when charging first detected

function buildConnectOptions() {
  const opts = { reconnectPeriod: 5000, connectTimeout: 10_000 };
  const user = process.env.MQTT_USER;
  const pass = process.env.MQTT_PASS;
  if (user) { opts.username = user; opts.password = pass; }
  return opts;
}

// Map MQTT topic suffix → state field name and parser
const FIELD_MAP = {
  "Status":                        { key: "status",              parse: String },
  "Current":                       { key: "current_a",           parse: parseFloat },
  "Voltage":                       { key: "voltage_v",           parse: parseFloat },
  "Power":                         { key: "power_w",             parse: parseFloat },
  "Temperature":                   { key: "temperature_f",       parse: parseFloat },
  "Energy--Session-":              { key: "session_energy_wh",   parse: parseFloat },
  "Energy--Lifetime-":             { key: "lifetime_energy_wh",  parse: parseFloat },
  "Frequency":                     { key: "frequency_hz",        parse: parseFloat },
  "Power-Factor":                  { key: "power_factor",        parse: parseFloat },
  "Current-Rating":                { key: "current_rating_a",    parse: parseFloat },
  "Max-Current-Online-Device-":    { key: "max_current_online_a",  parse: parseFloat },
  "Max-Current-Online-Wanted-":    { key: "max_current_wanted_a",  parse: parseFloat },
};

function handleMessage(topic, payload) {
  const val = payload.toString().trim();
  // Match hmd/sensor/JuiceBox/<Field>/state or hmd/number/JuiceBox/<Field>/state
  const m = topic.match(/^hmd\/(?:sensor|number)\/JuiceBox\/(.+)\/state$/);
  if (!m) return;
  const fieldName = m[1];
  const mapping   = FIELD_MAP[fieldName];
  if (!mapping) return;

  const prev   = state.status;
  state[mapping.key] = mapping.parse(val);

  // Track session start time
  if (mapping.key === "status") {
    if (val === "Charging" && prev !== "Charging") {
      sessionStart = new Date();
    } else if (val !== "Charging") {
      sessionStart = null;
    }
  }
}

export function connect() {
  mqttClient = mqtt.connect(BROKER, buildConnectOptions());

  mqttClient.on("connect", () => {
    console.log(`[juicebox] Connected to MQTT at ${BROKER}`);
    // Subscribe to all hmd state topics
    mqttClient.subscribe(`${HMD}/#`, { qos: 1 }, (err) => {
      if (err) console.error("[juicebox] Subscribe error:", err.message);
      else     console.log(`[juicebox] Subscribed to ${HMD}/#`);
    });
  });

  mqttClient.on("message",   handleMessage);
  mqttClient.on("error",     (e) => console.error("[juicebox] MQTT error:", e.message));
  mqttClient.on("reconnect", ()  => console.log("[juicebox] Reconnecting to MQTT…"));
  mqttClient.on("offline",   ()  => console.log("[juicebox] MQTT client offline"));
}

function publish(topic, payload) {
  if (!mqttClient?.connected) {
    throw new Error("MQTT client not connected — charger commands unavailable");
  }
  const msg = typeof payload === "string" ? payload : String(payload);
  mqttClient.publish(topic, msg, { qos: 1 });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getState()        { return Object.keys(state).length ? { ...state } : null; }
export function getSessionStart() { return sessionStart; }
export function isConnected()     { return mqttClient?.connected ?? false; }

/**
 * Start charging at the given amps (6–40A).
 * Sets Max-Current-Online-Wanted to the requested value.
 */
export function startCharging(amps = 32) {
  if (amps < 6 || amps > 40) throw new RangeError("amps must be 6–40");
  publish(`${HMD}/number/${DEVICE}/Max-Current-Offline-Wanted-/command`, amps);
  publish(`${HMD}/number/${DEVICE}/Max-Current-Online-Wanted-/command`, amps);
}

/**
 * Stop charging by setting online current limit to 0.
 * JPP requires both online and offline limits to be defined before it will
 * build and send the UDP command packet. We initialize offline to 32A (safe
 * default matching J1772 minimum) if it hasn't been set yet.
 */
export function stopCharging() {
  // Offline limit must be set or JPP errors: "Must have both current_max defined"
  publish(`${HMD}/number/${DEVICE}/Max-Current-Offline-Wanted-/command`, 32);
  publish(`${HMD}/number/${DEVICE}/Max-Current-Online-Wanted-/command`, 0);
}

/**
 * Adjust the max charging current mid-session.
 */
export function setCurrentLimit(amps) {
  if (amps < 6 || amps > 40) throw new RangeError("amps must be 6–40");
  publish(`${HMD}/number/${DEVICE}/Max-Current-Offline-Wanted-/command`, amps);
  publish(`${HMD}/number/${DEVICE}/Max-Current-Online-Wanted-/command`, amps);
}
