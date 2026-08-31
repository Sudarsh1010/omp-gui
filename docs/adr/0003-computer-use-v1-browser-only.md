# Computer use v1 is browser-only

**Status:** accepted

Version 1's computer-use surface is browser use only: the agent drives a browser surfaced as a live pane in the app. Full screen capture and synthesized OS-level input are explicitly out of scope for v1.

Full-screen control was rejected for v1 on three grounds: (1) the macOS permission story — Screen Recording plus Accessibility TCC grants — *is* the product, and synthetic input to arbitrary apps is malware-class capability requiring its own security model (interlocks, allowlists, user-presence affordances, prompt-injection defenses); (2) browser control rides CDP, a permission-free, fully-scriptable protocol that shares almost no machinery with ScreenCaptureKit/CGEvent-based screen control, so "browser now, screen later" would not have been incremental anyway; (3) omp already ships browser/CDP machinery, so the app's differentiator is the visual surface and approval UX, not the control protocol.

The host-tool namespace is designed for the deferred future: browser tools live under `browser.*` now; `screen.*` and `input.*` are reserved as a security-gated tier. Adding full computer use later means registering new host tools, not re-architecting the session layer. Any v2 full-screen work gets its own security design doc before implementation.
