---
covers:
  - 'fix(relay): honor saved permissions for agent messages'
---

### Fixed

- Honor your chosen file and command permissions when an agent receives a message. Existing conversations keep their saved setting; new ones inherit the agent or app default. A chat connection's explicit permission setting still takes precedence.
- Apply permission changes to already-open Claude conversations, including when the next message needs a different setting.
