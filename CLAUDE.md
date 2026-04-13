# claude-juicebox

## What This Project Is
MCP server that restores local control over a JuiceBox Pro 40 EV charger after Enel X / JuiceNet shut down their cloud service. Architecture: JuicePassProxy intercepts charger UDP traffic, routes it through a local Mosquitto MQTT broker, and an MCP server exposes tools for charging status, session info, current limiting, and diagnostics. Designed to run on a Synology NAS via Docker Compose.

## Tech Stack
- Docker Compose (orchestration)
- Node.js MCP server (TypeScript)
- Mosquitto (MQTT broker — local)
- JuicePassProxy (UDP relay — bridges charger to MQTT)
- Express (optional REST layer)

## Key Decisions
- All traffic stays local — no cloud dependency post-setup
- JuicePassProxy runs in Docker alongside Mosquitto; charger talks to it instead of JuiceNet
- MCP server subscribes to MQTT topics to read state and publishes commands
- Target deployment: Synology NAS

## Session Startup Checklist
1. Read ROADMAP.md to find the current active task
2. Check MEMORY.md if it exists — it contains auto-saved learnings from prior sessions
3. Review `PLAN.md` for architecture decisions before implementing
4. Run `docker-compose up` from repo root to start local stack for testing
5. Do not make architectural changes without confirming with Charles first

## Key Files
- `PLAN.md` — detailed architecture and implementation plan
- `docker-compose.yml` — service orchestration (Mosquitto, JuicePassProxy, MCP)
- `mcp-server/` — Node.js MCP server source
- `mosquitto/` — Mosquitto broker config
- `docs/` — setup and wiring documentation

---
@~/Documents/GitHub/CLAUDE.md
