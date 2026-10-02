---
covers:
  - 'fix(session): deduplicate conversations across nested agents'
  - 'fix(session): normalize restored recent conversation lists'
---

### Fixed

- Stop repeated conversations from accumulating in Today when agents work in nested folders, including lists saved by older app versions. Count each conversation once in Activity, too.
