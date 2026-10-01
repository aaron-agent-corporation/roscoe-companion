---
covers:
  - 'fix(messaging): enable runtime Relay tools and bounded agent DMs'
---

### Fixed

- Give Codex and OpenCode agents the tools to message other agents, read their own replies, and schedule tasks (#1).
- Let agents start bounded conversations in direct messages. Explain when a mentioned agent cannot reply, without repeating the notice on every post (#2).
- Let Codex open its tools on the first message from another agent. Keep successful replies successful when Codex only shortened skill descriptions.
- Supply tool safety details so Codex can use messaging tools during unattended turns while enforcing message limits.
