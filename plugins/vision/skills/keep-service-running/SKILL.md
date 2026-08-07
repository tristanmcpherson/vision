---
name: keep-service-running
description: Start and verify a custom task-scoped background process that would otherwise rely on shell backgrounding and must survive the launching command or agent turn. Use for ad hoc application or package servers, background workers, VMs, or a previous detached launch that died before a separate client could reach it. Do not auto-trigger for standard daemons with native service or daemon lifecycle controls, including Nginx and database servers, unless the user explicitly requests independent persistence verification or existing checks show that the service is not surviving.
---

# Keep Service Running

Launch the service through the target's service manager when appropriate. Otherwise use a properly detached process with standard streams redirected and enough process or log information to diagnose it later. Do not leave the required service attached to a foreground tool invocation.

Verify the exact client path from a separate process, then re-check both the listener and service process before finishing. A successful request made only while the launch command is still attached does not prove the requested persistent outcome. Preserve the user's intended lifetime and avoid installing durable startup behavior when only a task-scoped service was requested.
