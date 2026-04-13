/**
 * Unit tests for juiceboxClient.js
 *
 * The mqtt package is fully mocked so no real broker is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the mqtt package before importing the module under test
// ---------------------------------------------------------------------------

// Shared mock client instance — tests can access it via getMockClient()
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

    subscribe(_topic, _opts, cb) {
      if (cb) cb(null);
      return client;
    },

    publish: vi.fn(),

    // Test helper: simulate receiving a message
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
// Import module under test (after mock registration)
// ---------------------------------------------------------------------------

// We need a fresh module for each describe block that calls connect(), so we
// use dynamic imports with cache-busting via vi.resetModules().

async function freshClient() {
  vi.resetModules();
  // Re-register mock after resetModules
  vi.mock("mqtt", () => ({
    default: {
      connect: vi.fn(() => {
        _mockClient = makeMockClient();
        return _mockClient;
      }),
    },
  }));
  const mod = await import("../juiceboxClient.js");
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("juiceboxClient", () => {
  let client;

  beforeEach(async () => {
    client = await freshClient();
  });

  // -------------------------------------------------------------------------
  it("connect() subscribes to the state topic", async () => {
    client.connect();
    const subscribeSpy = vi.spyOn(_mockClient, "subscribe");
    // Trigger the "connect" event on the mock client
    _mockClient._emit("connect");
    expect(subscribeSpy).toHaveBeenCalledWith(
      expect.stringContaining("state"),
      expect.objectContaining({ qos: 1 }),
      expect.any(Function)
    );
  });

  // -------------------------------------------------------------------------
  it("getState() returns null before any message is received", () => {
    client.connect();
    expect(client.getState()).toBeNull();
  });

  // -------------------------------------------------------------------------
  it("normalises state when a message arrives", () => {
    client.connect();
    _mockClient._emit("connect");

    const raw = {
      state: "charging",
      amps: 24,
      voltage: 240,
      watts: 5760,
      watt_hours_session: 1200,
      temperature: 35,
      signal: -65,
      firmware_version: "1.2.3",
    };
    _mockClient._emit("message", "juicebox/JuiceBox-0E8/state", Buffer.from(JSON.stringify(raw)));

    const s = client.getState();
    expect(s).not.toBeNull();
    expect(s.state).toBe("charging");
    expect(s.current_a).toBe(24);
    expect(s.voltage_v).toBe(240);
    expect(s.power_w).toBe(5760);
    expect(s.session_energy_wh).toBe(1200);
    expect(s.temperature_c).toBe(35);
    expect(s.signal_dbm).toBe(-65);
    expect(s.firmware_version).toBe("1.2.3");
  });

  // -------------------------------------------------------------------------
  it("handles field aliases: amps→current_a, watts→power_w", () => {
    client.connect();
    _mockClient._emit("connect");

    const raw = { state: "available", amps: 32, watts: 0, voltage: 240 };
    _mockClient._emit("message", "t", Buffer.from(JSON.stringify(raw)));

    const s = client.getState();
    expect(s.current_a).toBe(32);
    expect(s.power_w).toBe(0);
  });

  it("handles alternate aliases: current→current_a, power→power_w, energy_session→session_energy_wh, firmware→firmware_version", () => {
    client.connect();
    _mockClient._emit("connect");

    const raw = {
      state: "plugged",
      current: 16,
      power: 3840,
      energy_session: 800,
      firmware: "2.0.0",
    };
    _mockClient._emit("message", "t", Buffer.from(JSON.stringify(raw)));

    const s = client.getState();
    expect(s.current_a).toBe(16);
    expect(s.power_w).toBe(3840);
    expect(s.session_energy_wh).toBe(800);
    expect(s.firmware_version).toBe("2.0.0");
  });

  // -------------------------------------------------------------------------
  it("startCharging publishes the right MQTT payload", () => {
    client.connect();
    _mockClient.connected = true;

    client.startCharging(24);

    expect(_mockClient.publish).toHaveBeenCalledWith(
      expect.stringContaining("cmd"),
      JSON.stringify({ command: "override_start", amps: 24 }),
      { qos: 1 }
    );
  });

  // -------------------------------------------------------------------------
  it("stopCharging publishes the right payload", () => {
    client.connect();
    _mockClient.connected = true;

    client.stopCharging();

    expect(_mockClient.publish).toHaveBeenCalledWith(
      expect.stringContaining("cmd"),
      JSON.stringify({ command: "override_stop" }),
      { qos: 1 }
    );
  });

  // -------------------------------------------------------------------------
  it("setCurrentLimit publishes the right payload", () => {
    client.connect();
    _mockClient.connected = true;

    client.setCurrentLimit(16);

    expect(_mockClient.publish).toHaveBeenCalledWith(
      expect.stringContaining("cmd"),
      JSON.stringify({ command: "set_current", amps: 16 }),
      { qos: 1 }
    );
  });

  // -------------------------------------------------------------------------
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

  it("setCurrentLimit throws RangeError if amps out of range", () => {
    client.connect();
    _mockClient.connected = true;
    expect(() => client.setCurrentLimit(0)).toThrow(RangeError);
    expect(() => client.setCurrentLimit(50)).toThrow(RangeError);
  });

  // -------------------------------------------------------------------------
  it("startCharging throws if MQTT not connected", () => {
    client.connect();
    _mockClient.connected = false;
    expect(() => client.startCharging(32)).toThrow(/not connected/i);
  });

  // -------------------------------------------------------------------------
  it("session start time is set when state transitions to 'charging'", () => {
    client.connect();
    _mockClient._emit("connect");

    // First message: available
    _mockClient._emit("message", "t", Buffer.from(JSON.stringify({ state: "available" })));
    expect(client.getSessionStart()).toBeNull();

    // Transition to charging
    _mockClient._emit("message", "t", Buffer.from(JSON.stringify({ state: "charging" })));
    expect(client.getSessionStart()).toBeInstanceOf(Date);
  });

  it("session start time is cleared when state leaves 'charging'", () => {
    client.connect();
    _mockClient._emit("connect");

    _mockClient._emit("message", "t", Buffer.from(JSON.stringify({ state: "charging" })));
    expect(client.getSessionStart()).toBeInstanceOf(Date);

    _mockClient._emit("message", "t", Buffer.from(JSON.stringify({ state: "available" })));
    expect(client.getSessionStart()).toBeNull();
  });

  it("session start time is NOT reset on successive charging messages", () => {
    client.connect();
    _mockClient._emit("connect");

    _mockClient._emit("message", "t", Buffer.from(JSON.stringify({ state: "charging" })));
    const first = client.getSessionStart();

    _mockClient._emit("message", "t", Buffer.from(JSON.stringify({ state: "charging", amps: 30 })));
    expect(client.getSessionStart()).toBe(first); // same object
  });
});
