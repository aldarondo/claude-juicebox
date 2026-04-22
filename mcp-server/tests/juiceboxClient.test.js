/**
 * Unit tests for juiceboxClient.js (JuicePassProxy v0.5.x topic format)
 *
 * Messages arrive as individual MQTT topics:
 *   hmd/sensor/JuiceBox/<Field>/state  → string value
 *   hmd/number/JuiceBox/<Field>/state  → string number
 *
 * Commands are published as:
 *   hmd/number/JuiceBox/Max-Current-Online-Wanted-/command  → string amps
 *   hmd/number/JuiceBox/Max-Current-Offline-Wanted-/command → string amps
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the mqtt package
// ---------------------------------------------------------------------------

let _mockClient;

function makeMockClient() {
  const handlers = {};
  const client = {
    connected: false,
    _handlers: handlers,

    on(event, fn) {
      handlers[event] = fn;
      return client;
    },

    subscribe: vi.fn((_topic, _opts, cb) => {
      if (cb) cb(null);
      return client;
    }),

    publish: vi.fn(),

    _emit(event, ...args) {
      if (handlers[event]) handlers[event](...args);
    },
  };
  return client;
}

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => {
      _mockClient = makeMockClient();
      return _mockClient;
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fresh module per test (connect() sets module-level state)
// ---------------------------------------------------------------------------

async function freshClient() {
  vi.resetModules();
  vi.mock("mqtt", () => ({
    default: {
      connect: vi.fn(() => {
        _mockClient = makeMockClient();
        return _mockClient;
      }),
    },
  }));
  return import("../juiceboxClient.js");
}

// Helper: emit a single per-topic state message
function emitState(topic, value) {
  _mockClient._emit("message", topic, Buffer.from(String(value)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("juiceboxClient", () => {
  let client;

  beforeEach(async () => {
    client = await freshClient();
  });

  it("connect() subscribes to hmd/#", () => {
    client.connect();
    _mockClient._emit("connect");
    expect(_mockClient.subscribe).toHaveBeenCalledWith(
      "hmd/#",
      expect.objectContaining({ qos: 1 }),
      expect.any(Function)
    );
  });

  it("getState() returns null before any message is received", () => {
    client.connect();
    expect(client.getState()).toBeNull();
  });

  it("normalises state from per-topic messages", () => {
    client.connect();
    _mockClient._emit("connect");

    emitState("hmd/sensor/JuiceBox/Status/state",          "Charging");
    emitState("hmd/sensor/JuiceBox/Current/state",         "31.5");
    emitState("hmd/sensor/JuiceBox/Voltage/state",         "241.8");
    emitState("hmd/sensor/JuiceBox/Power/state",           "7614");
    emitState("hmd/sensor/JuiceBox/Temperature/state",     "120.2");
    emitState("hmd/sensor/JuiceBox/Energy--Session-/state","6592");
    emitState("hmd/sensor/JuiceBox/Frequency/state",       "60.01");

    const s = client.getState();
    expect(s).not.toBeNull();
    expect(s.status).toBe("Charging");
    expect(s.current_a).toBe(31.5);
    expect(s.voltage_v).toBe(241.8);
    expect(s.power_w).toBe(7614);
    expect(s.temperature_f).toBe(120.2);
    expect(s.session_energy_wh).toBe(6592);
    expect(s.frequency_hz).toBe(60.01);
  });

  it("ignores unrecognised topics", () => {
    client.connect();
    _mockClient._emit("connect");
    emitState("hmd/sensor/JuiceBox/UnknownField/state", "42");
    emitState("some/other/topic", "hello");
    expect(client.getState()).toBeNull();
  });

  it("number topics (Max-Current-Online-Wanted-) are parsed correctly", () => {
    client.connect();
    _mockClient._emit("connect");
    emitState("hmd/number/JuiceBox/Max-Current-Online-Wanted-/state", "32.0");
    const s = client.getState();
    expect(s.max_current_wanted_a).toBe(32.0);
  });

  // ---------------------------------------------------------------------------
  // startCharging
  // ---------------------------------------------------------------------------

  it("startCharging publishes offline AND online limits", () => {
    client.connect();
    _mockClient.connected = true;
    client.startCharging(24);

    expect(_mockClient.publish).toHaveBeenCalledTimes(2);
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Offline-Wanted-/command",
      "24",
      { qos: 1 }
    );
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Online-Wanted-/command",
      "24",
      { qos: 1 }
    );
  });

  it("startCharging defaults to 32A", () => {
    client.connect();
    _mockClient.connected = true;
    client.startCharging();
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Online-Wanted-/command",
      "32",
      { qos: 1 }
    );
  });

  it("startCharging throws RangeError if amps < 6", () => {
    client.connect();
    _mockClient.connected = true;
    expect(() => client.startCharging(5)).toThrow(RangeError);
  });

  it("startCharging throws RangeError if amps > 40", () => {
    client.connect();
    _mockClient.connected = true;
    expect(() => client.startCharging(41)).toThrow(RangeError);
  });

  it("startCharging throws if MQTT not connected", () => {
    client.connect();
    _mockClient.connected = false;
    expect(() => client.startCharging(32)).toThrow(/not connected/i);
  });

  // ---------------------------------------------------------------------------
  // stopCharging
  // ---------------------------------------------------------------------------

  it("stopCharging publishes offline=32 and online=0", () => {
    client.connect();
    _mockClient.connected = true;
    client.stopCharging();

    expect(_mockClient.publish).toHaveBeenCalledTimes(2);
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Offline-Wanted-/command",
      "32",
      { qos: 1 }
    );
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Online-Wanted-/command",
      "0",
      { qos: 1 }
    );
  });

  // ---------------------------------------------------------------------------
  // setCurrentLimit
  // ---------------------------------------------------------------------------

  it("setCurrentLimit publishes offline AND online limits", () => {
    client.connect();
    _mockClient.connected = true;
    client.setCurrentLimit(16);

    expect(_mockClient.publish).toHaveBeenCalledTimes(2);
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Offline-Wanted-/command",
      "16",
      { qos: 1 }
    );
    expect(_mockClient.publish).toHaveBeenCalledWith(
      "hmd/number/JuiceBox/Max-Current-Online-Wanted-/command",
      "16",
      { qos: 1 }
    );
  });

  it("setCurrentLimit throws RangeError if amps out of range", () => {
    client.connect();
    _mockClient.connected = true;
    expect(() => client.setCurrentLimit(0)).toThrow(RangeError);
    expect(() => client.setCurrentLimit(50)).toThrow(RangeError);
  });

  // ---------------------------------------------------------------------------
  // Session tracking
  // ---------------------------------------------------------------------------

  it("session start time is set when Status transitions to Charging", () => {
    client.connect();
    _mockClient._emit("connect");

    emitState("hmd/sensor/JuiceBox/Status/state", "Plugged In");
    expect(client.getSessionStart()).toBeNull();

    emitState("hmd/sensor/JuiceBox/Status/state", "Charging");
    expect(client.getSessionStart()).toBeInstanceOf(Date);
  });

  it("session start time is cleared when Status leaves Charging", () => {
    client.connect();
    _mockClient._emit("connect");

    emitState("hmd/sensor/JuiceBox/Status/state", "Charging");
    expect(client.getSessionStart()).toBeInstanceOf(Date);

    emitState("hmd/sensor/JuiceBox/Status/state", "Plugged In");
    expect(client.getSessionStart()).toBeNull();
  });

  it("session start time is NOT reset on successive Charging messages", () => {
    client.connect();
    _mockClient._emit("connect");

    emitState("hmd/sensor/JuiceBox/Status/state", "Charging");
    const first = client.getSessionStart();

    emitState("hmd/sensor/JuiceBox/Status/state", "Charging");
    expect(client.getSessionStart()).toBe(first);
  });
});
