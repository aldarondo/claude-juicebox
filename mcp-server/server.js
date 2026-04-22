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
 * Add to Claude:  http://<YOUR-NAS-IP>:3001/sse  (or your MCP_PORT)
 * Health check:   http://<YOUR-NAS-IP>:3001/health
 */

import express from "express";
import cron    from "node-cron";
import { appendFileSync, readFileSync, existsSync, statSync, renameSync } from "fs";
import { McpServer }        from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import * as juicebox from "./juiceboxClient.js";
import { isTimeInSchedule } from "./scheduleUtils.js";
import { STATUS } from "./constants.js";

const PORT     = process.env.PORT     || 3001;
const TZ       = process.env.TZ_OVERRIDE || "America/Phoenix";
const LOG_FILE = process.env.LOG_FILE || "/logs/mcp.log";
const LOG_MAX_BYTES = 500_000; // rotate at 500 KB

function writeLogFile(line) {
  try {
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* non-fatal — local dev may not have /logs */ }
}

// Patch console so all output (including juiceboxClient.js) goes to both
// stdout and the persistent log file.
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...args) => {
  const line = `[${new Date().toISOString()}] INFO  ${args.join(" ")}`;
  _log(line);
  writeLogFile(line);
};
console.error = (...args) => {
  const line = `[${new Date().toISOString()}] ERROR ${args.join(" ")}`;
  _err(line);
  writeLogFile(line);
};

// Connect to MQTT on startup
juicebox.connect();

// ---------------------------------------------------------------------------
// Schedule state — module-level, shared across connections
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
// Factory: create a new McpServer instance per SSE connection.
// MCP SDK 1.9+ requires one McpServer per transport — a single shared server
// cannot be connected to more than one transport simultaneously. Claude Desktop
// opens a fresh SSE connection on every session, so each GET /sse creates its
// own server instance. Module-level state (scheduleJobs, activeSchedule) is
// intentionally shared across all instances so schedules survive reconnects.
// ---------------------------------------------------------------------------

export function createMcpServer() {
  const server = new McpServer({ name: "juicebox", version: "1.0.0" });

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
        charging:           s.status === STATUS.CHARGING,
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
    "get_logs",
    "Returns recent MCP server log entries from the persistent log file. " +
    "Log survives container replacement — use this to diagnose past events after a redeploy.",
    { lines: z.number().min(1).max(2000).optional().describe("Number of recent lines to return (default 200)") },
    async ({ lines = 200 } = {}) => {
      if (!existsSync(LOG_FILE)) {
        return { content: [{ type: "text", text: `No log file found at ${LOG_FILE} — container may not have a /logs volume mounted.` }] };
      }
      const content = readFileSync(LOG_FILE, "utf8");
      const all = content.split("\n").filter(Boolean);
      const recent = all.slice(-lines).join("\n");
      return { content: [{ type: "text", text: recent || "(log file is empty)" }] };
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
        start:    z.string().regex(/^\d{2}:\d{2}$/)
                   .refine(t => { const [h,m] = t.split(":").map(Number); return h < 24 && m < 60; }, "hours must be 0–23, minutes 0–59")
                   .describe(`Window open time HH:MM (24h, ${TZ})`),
        end:      z.string().regex(/^\d{2}:\d{2}$/)
                   .refine(t => { const [h,m] = t.split(":").map(Number); return h < 24 && m < 60; }, "hours must be 0–23, minutes 0–59")
                   .describe(`Window close time HH:MM (24h, ${TZ})`),
        max_amps: z.number().min(6).max(40).describe("Max charging current for this window (amps)"),
      })).describe("Charging windows. Pass [] to clear the schedule and stop all scheduled charging."),
    },
    async ({ schedule }) => {
      clearSchedule();

      // If current time is outside all windows in the new schedule, stop any
      // in-progress session immediately rather than waiting for the next cron.
      const stoppedImmediately = !isTimeInSchedule(schedule);
      if (stoppedImmediately) {
        try { juicebox.stopCharging(); }
        catch (e) { console.error(`[schedule] Failed to stop charging on schedule update: ${e.message}`); }
      }

      if (schedule.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({
          success: true,
          message: "Schedule cleared — no scheduled charging active.",
          stopped_immediately: stoppedImmediately,
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
          (() => {
            let fails = 0;
            return () => {
              console.log(`[schedule] START charging at ${window.max_amps}A — ${label}`);
              try { juicebox.startCharging(window.max_amps); fails = 0; }
              catch (e) {
                fails++;
                console.error(`[schedule] Failed to start charging (fail #${fails}): ${e.message}`);
                if (fails >= 3) console.error(`[schedule] WARNING: ${fails} consecutive failures for "${label}" start — check MQTT`);
              }
            };
          })(),
          { timezone: TZ }
        );

        const stopJob = cron.schedule(
          `${endM} ${endH} * * ${cronDays}`,
          (() => {
            let fails = 0;
            return () => {
              console.log(`[schedule] STOP charging — ${label}`);
              try { juicebox.stopCharging(); fails = 0; }
              catch (e) {
                fails++;
                console.error(`[schedule] Failed to stop charging (fail #${fails}): ${e.message}`);
                if (fails >= 3) console.error(`[schedule] WARNING: ${fails} consecutive failures for "${label}" stop — check MQTT`);
              }
            };
          })(),
          { timezone: TZ }
        );

        scheduleJobs.push(startJob, stopJob);
      }

      return { content: [{ type: "text", text: JSON.stringify({
        success:             true,
        windows_scheduled:   schedule.length,
        cron_jobs_created:   scheduleJobs.length,
        stopped_immediately: stoppedImmediately,
        schedule,
      }, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express + SSE transport
// ---------------------------------------------------------------------------

const app = express();

// Track active SSE transports so POST /messages can route to the right one
const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  res.on("close", () => transports.delete(transport.sessionId));
  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, mqtt_connected: juicebox.isConnected(), schedule_jobs: scheduleJobs.length });
});

app.listen(PORT, () => {
  console.log(`[mcp] JuiceBox MCP server listening on port ${PORT}`);
  console.log(`[mcp] SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`[mcp] Health:       http://localhost:${PORT}/health`);
});
