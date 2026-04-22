/**
 * Returns true if the current local time (America/Phoenix) falls within any
 * window in the given schedule. Used to decide whether to stop charging
 * immediately when a new schedule is pushed.
 *
 * Handles overnight windows (e.g. start="22:00", end="06:00") by checking
 * whether the current minute is >= start OR < end on the named day.
 *
 * @param {Array} schedule - Array of schedule window objects
 * @param {Date} [now] - Override current time (for testing)
 */
export function isTimeInSchedule(schedule, now = new Date()) {
  if (!schedule.length) return false;
  const local = new Date(now.toLocaleString("en-US", { timeZone: "America/Phoenix" }));
  const currentDay = ["sun","mon","tue","wed","thu","fri","sat"][local.getDay()];
  const currentMin = local.getHours() * 60 + local.getMinutes();

  for (const window of schedule) {
    if (!window.days.includes(currentDay)) continue;
    const [sh, sm] = window.start.split(":").map(Number);
    const [eh, em] = window.end.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const endMin   = eh * 60 + em;

    if (startMin <= endMin) {
      if (currentMin >= startMin && currentMin < endMin) return true;
    } else {
      // Overnight window — active if after start OR before end on the named day
      if (currentMin >= startMin || currentMin < endMin) return true;
    }
  }
  return false;
}
