/**
 * JuiceBox MCP Server
 *
 * Exposes tools for monitoring and controlling a JuiceBox Pro 40 EV charger.
 * State is read from JuicePassProxy via MQTT. Commands are sent via MQTT.
 *
 * Key tool for the Enphase coordinator:
 *   set_charging_schedule — programs a weekly schedule of charging windows
 *   (days + start/end time + max amps). The coordinator calls this after
 *   fetching TOU rates from the Enphase MCP and deciding the cheapest windows.
 *   An internal cron scheduler executes start/stop commands at the right times.
 *
 * Add to Claude:  http://192.168.0.64:3001/sse  (or your MCP_PORT)
 * Health check:   http://192.168.0.64:3001/health
 */

import express from "express";
import cron    from "node-cron";
import { McpServer }        from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as juicebox from "./juiceboxClient.js";

const PORT = process.env.PORT || 3001;

// Connect to MQTT on startup
juicebox.connect();

const server = new McpServer({ name: "juicebox", version: "1.0.0" });

// ---------------------------------------------------------------------------
// Schedule state — replaced atomically by set_charging_schedule
// ---------------------------------------------------------------------------

let scheduleJobs   = [];   // active node-cron tasks
let activeSchedule = [];   // last schedule passed by the coordinator (for inspection)

// day name → cron weekday number (0 = Sunday … 6 = Saturday)
const DAY_NUM = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function toCronDays(days) {
  return days.map(d => DAY_NUM[d]).join(",");
}

function clearSchedule() {
  scheduleJobs.forEach(j => j.stop());
  scheduleJobs   = [];
  activeSchedule = [];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "get_charger_status",
  "Returns current charging state (charging/available/plugged/error), power (W), " +
  "current (A), voltage (V), temperature (°C), and MQTT connection status.",
  {},
  async () => {
    const s = juicebox.getState();
    if (!s) {
      return { content: [{ type: "text", text: JSON.stringify({
        error: "No state received yet — charger may be offline or JuicePassProxy not running.",
        mqtt_connected: juicebox.isConnected(),
      }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({
      state:          s.status,
      power_w:        s.power_w,
      current_a:      s.current_a,
      voltage_v:      s.voltage_v,
      temperature_f:  s.temperature_f,
      signal_dbm:     s.signal_dbm,
      mqtt_connected: juicebox.isConnected(),
    }, null, 2) }] };
  }
);

server.tool(
  "get_session_info",
  "Returns active charging session details: energy delivered (kWh), elapsed time (minutes), " +
  "and session start time. Returns nulls if no session is active.",
  {},
  async () => {
    const s     = juicebox.getState();
    const start = juicebox.getSessionStart();
    if (!s) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No state data available." }) }] };
    }
    const elapsedMin = start
      ? Math.round((Date.now() - start.getTime()) / 60_000)
      : null;
    const energyKwh = s.session_energy_wh != null
      ? +( s.session_energy_wh / 1000).toFixed(3)
      : null;
    return { content: [{ type: "text", text: JSON.stringify({
      charging:           s.state === "charging",
      session_energy_kwh: energyKwh,
      session_start:      start?.toISOString() ?? null,
      elapsed_minutes:    elapsedMin,
    }, null, 2) }] };
  }
);

server.tool(
  "start_charging",
  "Enables charging immediately. Optionally set max current in amps (6–40A, default 32A).",
  { max_amps: z.number().min(6).max(40).optional().describe("Max charging current in amps (default 32)") },
  async ({ max_amps = 32 }) => {
    juicebox.startCharging(max_amps);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, command: "start_charging", max_amps }) }] };
  }
);

server.tool(
  "stop_charging",
  "Stops / pauses charging immediately.",
  {},
  async () => {
    juicebox.stopCharging();
    return { content: [{ type: "text", text: JSON.stringify({ success: true, command: "stop_charging" }) }] };
  }
);

server.tool(
  "set_current_limit",
  "Adjusts the maximum charging current during an active session (6–40A for JuiceBox Pro 40). " +
  "Use this to throttle during on-peak rate hours without stopping the session entirely.",
  { amps: z.number().min(6).max(40).describe("Target charging current in amps") },
  async ({ amps }) => {
    juicebox.setCurrentLimit(amps);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, current_limit_a: amps }) }] };
  }
);

server.tool(
  "get_diagnostics",
  "Returns firmware version, WiFi signal strength (dBm), and MQTT connection status.",
  {},
  async () => {
    const s = juicebox.getState();
    return { content: [{ type: "text", text: JSON.stringify({
      firmware_version:    s?.firmware_version ?? null,
      wifi_signal_dbm:     s?.signal_dbm       ?? null,
      mqtt_connected:      juicebox.isConnected(),
      state_data_received: s !== null,
    }, null, 2) }] };
  }
);

server.tool(
  "get_charging_schedule",
  "Returns the currently programmed charging schedule (the one last set by set_charging_schedule).",
  {},
  async () => {
    return { content: [{ type: "text", text: JSON.stringify({
      schedule:   activeSchedule,
      job_count:  scheduleJobs.length,
    }, null, 2) }] };
  }
);

server.tool(
  "set_charging_schedule",
  "Programs a weekly EV charging schedule. " +
  "The Enphase coordinator calls this after fetching TOU rates (enphase_get_tariff) and " +
  "battery SOC (enphase_get_status) to schedule charging during the cheapest rate windows " +
  "or when solar production will be high. " +
  "Each entry defines which days, start/end time (HH:MM 24h, America/Phoenix timezone), " +
  "and the max charging current in amps. " +
  "Calling this replaces the entire previous schedule. Pass an empty array to clear all scheduled charging.",
  {
    schedule: z.array(z.object({
      label:    z.string().optional().describe("Human-readable label, e.g. 'Weekday off-peak'"),
      days:     z.array(z.enum(["mon","tue","wed","thu","fri","sat","sun"])).min(1)
                 .describe("Days of week this window applies to"),
      start:    z.string().regex(/^\d{2}:\d{2}$/).describe("Window open time HH:MM (24h, America/Phoenix)"),
      end:      z.string().regex(/^\d{2}:\d{2}$/).describe("Window close time HH:MM (24h, America/Phoenix)"),
      max_amps: z.number().min(6).max(40).describe("Max charging current for this window (amps)"),
    })).describe("Charging windows. Pass [] to clear the schedule and stop all scheduled charging."),
  },
  async ({ schedule }) => {
    clearSchedule();

    if (schedule.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({
        success: true,
        message: "Schedule cleared — no scheduled charging active.",
        jobs: 0,
      }) }] };
    }

    activeSchedule = schedule;

    for (const window of schedule) {
      const [startH, startM] = window.start.split(":").map(Number);
      const [endH,   endM]   = window.end.split(":").map(Number);
      const cronDays = toCronDays(window.days);
      const label    = window.label ?? `${window.start}–${window.end}`;

      const startJob = cron.schedule(
        `${startM} ${startH} * * ${cronDays}`,
        () => {
          console.log(`[schedule] START charging at ${window.max_amps}A — ${label}`);
          try { juicebox.startCharging(window.max_amps); }
          catch (e) { console.error(`[schedule] Failed to start charging: ${e.message}`); }
        },
        { timezone: "America/Phoenix" }
      );

      const stopJob = cron.schedule(
        `${endM} ${endH} * * ${cronDays}`,
        () => {
          console.log(`[schedule] STOP charging — ${label}`);
          try { juicebox.stopCharging(); }
          catch (e) { console.error(`[schedule] Failed to stop charging: ${e.message}`); }
        },
        { timezone: "America/Phoenix" }
      );

      scheduleJobs.push(startJob, stopJob);
    }

    return { content: [{ type: "text", text: JSON.stringify({
      success:           true,
      windows_scheduled: schedule.length,
      cron_jobs_created: scheduleJobs.length,
      schedule,
    }, null, 2) }] };
  }
);

// ---------------------------------------------------------------------------
// Express + SSE transport
// ---------------------------------------------------------------------------

const app = express();

// Track active SSE sessions so POST /messages can route to the right transport
const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mqtt_connected: juicebox.isConnected(), schedule_jobs: scheduleJobs.length });
});

app.listen(PORT, () => {
  console.log(`[mcp] JuiceBox MCP server listening on port ${PORT}`);
  console.log(`[mcp] SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`[mcp] Health:       http://localhost:${PORT}/health`);
});
