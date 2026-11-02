# Changelog

## 0.2.0

Found while recording a coding agent using the MCP tools on a real TypeScript project.

- **MCP: no stale errors.** `get_errors` and `wait_for_builds` now report only errors from the current (or last) build. Previously, an error that had already been fixed was still listed under a process that was back to ready, which an agent could mistake for a live failure.
- **Correct build durations for servers that restart themselves.** A dev server that restarts in-process (e.g. `node --watch`) and announces it is ready again no longer reports the time since it first started as its build time.
- **MCP output uses local time**, matching the timestamps build tools print in their own logs.
- README: demo of an agent breaking a build, reading the error over MCP, fixing it and confirming the build is green.

## 0.1.0

First release: supervised build watches and dev servers, crash backoff, status page, and MCP tools over stdio and HTTP.
