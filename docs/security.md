# Security model

Agent-authored Lua is untrusted code.

## Required controls for `craftos_run` and sessions

- Launch only a configured CraftOS-PC executable; never accept an executable
  or arbitrary command-line flags from an MCP request.
- Create a unique runtime directory per invocation.
- Mount only an explicit workspace subtree. Prefer read-only mounts and copy
  declared outputs back after successful execution.
- Block private and local addresses for HTTP and websockets by default, as
  CC:Tweaked does (`$private`). Public addresses are reachable, as on a real
  server; deny them at the OS/container layer if programs must stay offline.
- Enforce wall-clock timeout, process-tree termination, output-size limits,
  file-count/size quotas, and concurrent-session limits.
- Resolve and verify every path after normalization and symlink handling.
- Delete only the exact runtime directory allocated to the invocation.
- Return explicit timeout, crash, protocol, validation, and engine errors.
- Redact host paths and environment values from normal MCP responses.

## Why an outer sandbox is mandatory

CraftOS-PC fixed a filesystem sandbox escape and data leak in v2.8.3
([GHSA-hr3w-wc83-6923](https://github.com/MCJack123/craftos2/security/advisories/GHSA-hr3w-wc83-6923)).
Pinning the fixed version is necessary but does not make its application-level
sandbox a sufficient boundary for arbitrary generated code.

The production execution profile should use a locked-down container, Windows
Sandbox/Hyper-V, or an equivalent restricted worker account. The MCP process
should remain outside that boundary and communicate through a narrow protocol.

## Threats to test explicitly

- `..`, absolute, UNC, alternate data stream, and symlink path escapes
- oversized terminal/file output and decompression-like expansion
- infinite loops and forked/orphaned processes
- HTTP, WebSocket, DNS, and local-service access
- poisoned result files and malformed control frames
- cross-session computer data, modem traffic, or IDs
- secrets inherited through environment variables
