/**
 * Unit tests for the schedule-related MCP tools in server.js.
 *
 * Strategy:
 *  - Mock `node-cron` so no real cron jobs are created; capture scheduled jobs.
 *  - Mock `./juiceboxClient.js` so no MQTT connection is attempted.
 *  - Mock `@modelcontextprotocol/sdk/server/mcp.js` to capture the McpServer
 *    instance created by server.js, so we can call tool handlers directly.
 *  - All vi.mock() calls are hoisted, so the captured instance is stored in
 *    a module-level variable that the mock factory closes over.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { isTimeInSchedule } from "../scheduleUtils.js";

// ---------------------------------------------------------------------------
// Module-level state shared between mock factories and tests
// ---------------------------------------------------------------------------

// Captured McpServer instance (set inside the McpServer subclass constructor)
let _capturedServer = null;

// Cron jobs created during this test file's run
let _cronJobs = [];

// ---------------------------------------------------------------------------
// Mocks — vi.mock() is hoisted by Vitest to the top of the file, so these
// run before any import/test code, but they still close over module-level vars.
// ---------------------------------------------------------------------------

vi.mock("node-cron", () => {
  return {
    default: {
      schedule: vi.fn((_expr, _fn, _opts) => {
        const job = { stop: vi.fn() };
        _cronJobs.push(job);
        return job;
      }),
    },
  };
});

vi.mock("../juiceboxClient.js", () => ({
  connect:         vi.fn(),
  getState:        vi.fn(() => null),
  getSessionStart: vi.fn(() => null),
  isConnected:     vi.fn(() => false),
  startCharging:   vi.fn(),
  stopCharging:    vi.fn(),
  setCurrentLimit: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", async (importOriginal) => {
  const real = await importOriginal();
  const RealMcpServer = real.McpServer;
  class CapturingMcpServer extends RealMcpServer {
    constructor(...args) {
      super(...args);
      _capturedServer = this;
    }
  }
  return { ...real, McpServer: CapturingMcpServer };
});

// ---------------------------------------------------------------------------
// Import server.js and call createMcpServer() to trigger the capture.
// createMcpServer() calls new McpServer(), which sets _capturedServer via the
// CapturingMcpServer constructor above. Must be called explicitly because
// createMcpServer() only runs inside the SSE handler in production.
// ---------------------------------------------------------------------------

const { createMcpServer } = await import("../server.js");
createMcpServer();

// ---------------------------------------------------------------------------
// Helper: invoke a registered MCP tool handler by name
// ---------------------------------------------------------------------------

async function callTool(name, args = {}) {
  const tool = _capturedServer._registeredTools[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(args);
}

// Helper: reset cron job tracking and stop any outstanding jobs
function resetCronJobs() {
  _cronJobs.forEach(j => j.stop());
  _cronJobs = [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server.js import sanity", () => {
  it("McpServer instance was captured", () => {
    expect(_capturedServer).not.toBeNull();
  });

  it("all 8 expected tools are registered", () => {
    const tools = Object.keys(_capturedServer._registeredTools);
    expect(tools).toContain("get_charger_status");
    expect(tools).toContain("get_session_info");
    expect(tools).toContain("start_charging");
    expect(tools).toContain("stop_charging");
    expect(tools).toContain("set_current_limit");
    expect(tools).toContain("get_diagnostics");
    expect(tools).toContain("get_charging_schedule");
    expect(tools).toContain("set_charging_schedule");
  });
});

describe("set_charging_schedule", () => {
  // Clear schedule and cron state before each test
  beforeAll(async () => {
    // Start from a clean slate
    await callTool("set_charging_schedule", { schedule: [] });
    resetCronJobs();
  });

  it("creates 2 cron jobs per window (start + stop)", async () => {
    resetCronJobs();
    const result = await callTool("set_charging_schedule", {
      schedule: [
        { days: ["mon", "tue", "wed"], start: "22:00", end: "06:00", max_amps: 32 },
      ],
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.success).toBe(true);
    expect(body.windows_scheduled).toBe(1);
    expect(body.cron_jobs_created).toBe(2);
    expect(_cronJobs).toHaveLength(2);
  });

  it("creates 2 cron jobs per window for multiple windows", async () => {
    resetCronJobs();
    const result = await callTool("set_charging_schedule", {
      schedule: [
        { days: ["mon", "tue"], start: "22:00", end: "06:00", max_amps: 32 },
        { days: ["sat", "sun"], start: "10:00", end: "14:00", max_amps: 24 },
      ],
    });
    const body = JSON.parse(result.content[0].text);

    expect(body.windows_scheduled).toBe(2);
    expect(body.cron_jobs_created).toBe(4);
    expect(_cronJobs).toHaveLength(4);
  });

  it("calling set_charging_schedule a second time clears previous jobs before adding new ones", async () => {
    resetCronJobs();

    await callTool("set_charging_schedule", {
      schedule: [{ days: ["mon"], start: "22:00", end: "06:00", max_amps: 32 }],
    });
    const firstJobs = [..._cronJobs]; // snapshot the first round's jobs
    expect(firstJobs).toHaveLength(2);

    // Second call — previous jobs should be stopped
    await callTool("set_charging_schedule", {
      schedule: [{ days: ["tue"], start: "08:00", end: "12:00", max_amps: 16 }],
    });

    for (const job of firstJobs) {
      expect(job.stop).toHaveBeenCalled();
    }

    // Active job count from the tool perspective
    const result = await callTool("get_charging_schedule", {});
    const body = JSON.parse(result.content[0].text);
    expect(body.job_count).toBe(2);
  });

  it("set_charging_schedule with an empty array clears all jobs", async () => {
    resetCronJobs();

    await callTool("set_charging_schedule", {
      schedule: [{ days: ["mon"], start: "22:00", end: "06:00", max_amps: 32 }],
    });
    const jobsBefore = [..._cronJobs];
    expect(jobsBefore).toHaveLength(2);

    const result = await callTool("set_charging_schedule", { schedule: [] });
    const body = JSON.parse(result.content[0].text);

    expect(body.success).toBe(true);
    expect(body.jobs).toBe(0);

    for (const job of jobsBefore) {
      expect(job.stop).toHaveBeenCalled();
    }

    const schedResult = await callTool("get_charging_schedule", {});
    const schedBody = JSON.parse(schedResult.content[0].text);
    expect(schedBody.job_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isTimeInSchedule unit tests
// ---------------------------------------------------------------------------

// Phoenix is UTC-7 (no DST). We use a fixed UTC timestamp so that
// toLocaleString("en-US", { timeZone: "America/Phoenix" }) gives predictable output.
// 2026-04-22T15:00:00Z === 2026-04-22 08:00 Wed America/Phoenix
const WED_0800_UTC = new Date("2026-04-22T15:00:00Z"); // 08:00 Wed Phoenix
const WED_2300_UTC = new Date("2026-04-23T06:00:00Z"); // 23:00 Wed Phoenix
const THU_0200_UTC = new Date("2026-04-23T09:00:00Z"); // 02:00 Thu Phoenix

describe("isTimeInSchedule", () => {
  it("returns false for empty schedule", () => {
    expect(isTimeInSchedule([], WED_0800_UTC)).toBe(false);
  });

  it("returns true when current time is inside a same-day window", () => {
    const schedule = [{ days: ["wed"], start: "07:00", end: "10:00", max_amps: 32 }];
    expect(isTimeInSchedule(schedule, WED_0800_UTC)).toBe(true);
  });

  it("returns false when current time is outside all windows", () => {
    const schedule = [{ days: ["wed"], start: "22:00", end: "06:00", max_amps: 32 }];
    expect(isTimeInSchedule(schedule, WED_0800_UTC)).toBe(false);
  });

  it("returns false when day does not match", () => {
    const schedule = [{ days: ["mon", "tue", "thu"], start: "07:00", end: "10:00", max_amps: 32 }];
    expect(isTimeInSchedule(schedule, WED_0800_UTC)).toBe(false);
  });

  it("returns true for overnight window — after start on named day", () => {
    // 23:00 Wed, window is 22:00–06:00 on Wed
    const schedule = [{ days: ["wed"], start: "22:00", end: "06:00", max_amps: 32 }];
    expect(isTimeInSchedule(schedule, WED_2300_UTC)).toBe(true);
  });

  it("returns true for overnight window — before end on next day", () => {
    // 02:00 Thu, overnight window started Wed, ends at 06:00 Thu
    const schedule = [{ days: ["thu"], start: "22:00", end: "06:00", max_amps: 32 }];
    expect(isTimeInSchedule(schedule, THU_0200_UTC)).toBe(true);
  });

  it("returns true when current time matches one of multiple windows", () => {
    const schedule = [
      { days: ["mon", "tue"], start: "22:00", end: "06:00", max_amps: 32 },
      { days: ["wed"], start: "07:30", end: "09:00", max_amps: 24 },
    ];
    expect(isTimeInSchedule(schedule, WED_0800_UTC)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// set_charging_schedule — immediate stop behaviour
// ---------------------------------------------------------------------------

describe("set_charging_schedule — immediate stop on schedule push", () => {
  it("stopped_immediately=false when all-day window covers current time", async () => {
    // 00:00–23:59 on all days covers every possible current time
    const result = await callTool("set_charging_schedule", {
      schedule: [{ days: ["sun","mon","tue","wed","thu","fri","sat"], start: "00:00", end: "23:59", max_amps: 32 }],
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.stopped_immediately).toBe(false);
  });

  it("stopped_immediately=true when schedule is cleared (empty array)", async () => {
    const result = await callTool("set_charging_schedule", { schedule: [] });
    const body = JSON.parse(result.content[0].text);
    expect(body.stopped_immediately).toBe(true);
    expect(body.jobs).toBe(0);
  });

  it("stopped_immediately is present in non-empty schedule response", async () => {
    const result = await callTool("set_charging_schedule", {
      schedule: [{ days: ["mon"], start: "22:00", end: "06:00", max_amps: 32 }],
    });
    const body = JSON.parse(result.content[0].text);
    expect(body).toHaveProperty("stopped_immediately");
    expect(typeof body.stopped_immediately).toBe("boolean");
  });
});

describe("get_charging_schedule", () => {
  it("returns the last set schedule", async () => {
    const schedule = [
      {
        label: "Weekday off-peak",
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "22:00",
        end: "06:00",
        max_amps: 32,
      },
    ];
    await callTool("set_charging_schedule", { schedule });

    const result = await callTool("get_charging_schedule", {});
    const body = JSON.parse(result.content[0].text);

    expect(body.schedule).toHaveLength(1);
    expect(body.schedule[0].label).toBe("Weekday off-peak");
    expect(body.schedule[0].max_amps).toBe(32);
    expect(body.schedule[0].start).toBe("22:00");
    expect(body.schedule[0].end).toBe("06:00");
  });

  it("returns empty schedule after clearing", async () => {
    await callTool("set_charging_schedule", { schedule: [] });

    const result = await callTool("get_charging_schedule", {});
    const body = JSON.parse(result.content[0].text);

    expect(body.schedule).toEqual([]);
    expect(body.job_count).toBe(0);
  });
});
