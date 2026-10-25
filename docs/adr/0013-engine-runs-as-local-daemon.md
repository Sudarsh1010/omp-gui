# The engine runs as a local daemon; the desktop app is a client

The engine (Workflow execution, Tracker, Sessions) runs as its own long-lived local process. The desktop app talks to it over a local socket protocol, relayed through the Rust shell; for Workflow Sessions the app's rpc-ui session layer consumes frames relayed from proteusd instead of a child process it spawned itself (adjusting ADR-0007).

This lets Autopilot WorkOrders survive the window closing or the GUI crashing, and leaves room for a CLI or remote client later without reworking the engine.

## Considered Options

- **Engine inside the GUI process.** Rejected: Sessions would die with the window, which makes multi-hour Autopilot runs fragile.
- **Remote-capable daemon in v1.** Deferred: it needs network auth and protocol hardening that v1 does not.
