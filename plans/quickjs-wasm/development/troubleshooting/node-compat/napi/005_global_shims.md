# Known Issue: Global shims

| | | Remarks |
| --- | --- | --- |
| **Status** | 🟠 | Removed from QuickJS N-API; remaining global support belongs in EdgeJS bootstrap. |
| **Severity** | Medium | Node and framework code probe for modern globals during bootstrap. |

## Current State

QuickJS N-API no longer installs broad Node-facing globals. Missing globals are
either accepted incompatibilities or EdgeJS runtime/bootstrap work.

## Known Incompatibility

Modern Node packages often probe for globals before choosing code paths.
QuickJS may not expose the same objects, or may expose them with different
behavior, which can push libraries into failing branches during startup.

## Current Status

Provide real engine-backed or EdgeJS-backed implementations where feasible.
Unsupported globals should fail in a way that works with Node-style capability
detection. Do not add silent N-API-level globals just to satisfy probes.
