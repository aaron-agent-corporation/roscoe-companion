# Agent messaging fixes: issues 1 and 2

## Checkout

- Fork: `aaron-agent-corporation/roscoe-companion`
- Branch: `codex/agent-messaging`
- Base: `996161118a84f938fe76b6e569ba077dfb7a574a`
- Checkout: `/Users/aaronwhaley/Agent-Corporation/_lawyerincorporated/roscoe-companion-work/agent-messaging`

The supplied `roscoe-companion` folder has no Git metadata. Every tracked file in
this checkout matched that source before editing. The supplied folder remains
unchanged. Changes are local and uncommitted.

## Issue 1: agent messaging tools

The authenticated runtime listener now registers the shared Relay, Mesh and Tasks
tool definitions. Codex and OpenCode receive the six agent messaging tools, with
the sender resolved from the runtime principal's agent home. Calls read the
inbound budget by canonical session ID at call time.

Registration uses the existing permission gate and hidden-tool list. Hidden tools
remain reachable through the existing permission-request flow. Both runtimes get
messaging instructions with their own tool prefix and permission-aware guidance.

## Issue 2: bounded DM conversations

An agent posting outside a room turn can join a recent DM conversation at its
highest recorded depth. A cold DM conversation starts at depth one, with a fixed
cap of three starts per author, room and rolling hour. The check and entry insert
share an immediate SQLite transaction. The cap survives server restarts because
it counts durable entries.

Outside-turn posts also spend the posting agent's repeat allowance. This closes
a further loophole reproduced during testing: a silent recipient could otherwise
be woken 30 times without writing any replies for the target-side counter to count.

Channels retain their existing triggering behavior. Refused outside-turn mentions
receive a notice once per posting author, room and clock hour. Ordinary
unaddressed posts stay quiet. Notice deduplication uses the existing bounded,
process-local notice-memory pattern; a server restart can repeat one notice.

## Verification

- Initial reproduction: all 12 new tests failed against the original code.
- Silent-recipient reproduction: 30 wakes before the additional source-side bound;
  the regression now passes with three wakes.
- Final room, HTTP route and runtime checks: **2,027 tests passed across 100 files**.
- The HTTP test submits 30 authenticated posts through `/api/rooms/:id/entries`.
- Real Relay query/reply, sender identity, inbox ownership, inherited hop limits,
  attempted budget expansion and permission revocation are covered.
- Existing runtime dispatch tests cover selection of Claude Code and Codex targets.
- Server typecheck passed.
- Changed TypeScript files: ESLint passed with zero errors and four file-size warnings.
- Formatting and `git diff --check` passed.

The initial broad room run passed 2,293 tests and failed ten. Three assertions
encoded the old silent-refusal behavior; their updated tests pass in the final
run. Seven Git worktree tests hit their five-second timeout during the concurrent
run. All seven passed when rerun with one worker and the same timeout.

## Live validation — October 1, 2026

Ran the patched server on loopback port 6422 with a separate validation database
and the existing Roscoe (Codex) and Perry (Claude Code) identities and sign-ins.
Scheduled jobs and tunneling were off. The original app settings were unchanged.
No paid API evaluation path was armed.

| Check                       | Result                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Roscoe tool inventory       | All six requested Relay/Mesh tools available                                                         |
| Roscoe → Perry              | Perry woke and returned `PERRY-ACK-MSG-20261001`                                                     |
| Perry → Roscoe              | Roscoe woke and returned `ROSCOE-ACK-MSG-20261001`; successful Relay result                          |
| Sender identity             | Stored delivery carries Roscoe's `relay.agent.whaley-firmvault.…` identity                           |
| Inbox ownership             | Roscoe read its own empty inbox; Perry's inbox returned `ENDPOINT_ACCESS_DENIED`                     |
| Cold DM start               | Roscoe posted from a private session at depth 1; Perry replied at depth 2; Roscoe replied at depth 3 |
| 30 authenticated HTTP posts | All joined that same root; one additional agent turn; one refusal notice                             |
| Channel behavior            | Two outside-turn mentions caused zero turns and one refusal notice                                   |
| Message permission blocked  | Fresh Roscoe session lacked all four Relay tools; both Mesh tools remained available                 |

The forward sent/reply IDs were `01M3W9498ARG8ERRY4YVGAK6BF` /
`01M3W94ERTE25G1BXTS3ESWNY3`. The final reverse IDs were
`01M3W9Q33N5DEWKFZ4A17FS0C4` / `01M3W9QA0JHKT1QZ8WSPW4S113`.
The DM was `01M3W93P0PRNC2FF4X06M58611`.

### Additional defects found and fixed

1. **First Relay turn lacked canonical session authority.** Codex refused the
   authenticated tool listener before producing content. Relay now records the
   selected runtime and agent at launch, removes its temporary row when no content
   runs, and preserves the durable owner after a real turn. Rekeyed Claude sessions
   keep ownership under the SDK ID. A new regression reproduced the original
   failure; tests also cover cleanup and preservation of existing ownership.
2. **A harmless Codex warning failed successful Relay replies.** Codex reports
   shortened skill descriptions as an error item, even when it completes the turn.
   That exact diagnostic now becomes a visible status notice. Unknown errors and
   terminal failures still fail, including a terminal failure repeating the same
   diagnostic text. The reverse exchange passed after this correction.

The broader tests also found one notification test asserting the old DM ceiling.
It now checks the bounded DM start and proves a notification to the operator wakes
no agent. The corresponding explanation was updated.

### Final verification and limits

- **1,498 tests passed across 87 files; eight skipped**, after the live fixes.
- Server and Relay typechecks passed.
- ESLint: zero errors; five file-size warnings in existing large files.
- The live evidence script verified the replies, sender, room depths, root count,
  notices, blocked tool inventory, and absence of channel sessions.
- Raw local evidence and the assertion summary are in the ignored
  `.validation/agent-messaging/` folder. The validation server was stopped afterward.

### Follow-up: live hop and call limits verified

The approval failure came from missing MCP safety annotations on the runtime
listener's hand-registered tools. Codex 0.154.0 treats an unannotated tool as
requiring approval. Its unattended `never` policy therefore rejected even
`mesh_list`. The runtime now reuses the existing Relay, Mesh and Tasks annotation
tables, with an explicit external-write annotation for `relay_notify_user`.
Missing metadata fails registration. Destructive tools retain their destructive
annotation, and inbox acknowledgment remains a write. The Codex approval policy,
filesystem sandbox and DorkOS permission gates are unchanged.

The same live Perry → Roscoe probes now pass through to Relay enforcement:

| Limit    | Rejected Roscoe send         | Server reason             |
| -------- | ---------------------------- | ------------------------- |
| One hop  | `01M3WB6262D766ZQH24T70YPE1` | `max hops exceeded (1/1)` |
| One call | `01M3WB6EV704TT2ADGTD0PZVYD` | `call budget exhausted`   |

Both stored traces record zero deliveries and no adapter dispatch. Both rejected
messages are retained only as dead letters. Roscoe returned the actual Relay error to
Perry in each case. The local assertion script saved these checks in
`.validation/agent-messaging/verified-budget-evidence.json`.

The metadata regression failed on both runtimes before the fix and passed after
it. The follow-up run passed **77 tests across nine files**, including runtime
permissions, external MCP registration and Codex turn options. Server typecheck,
targeted ESLint and formatting checks passed. The validation server was stopped
afterward.

### Pre-PR review

Independent review found two approval-routing gaps. Runtime hand tools now retain
both the canonical session ID and its working directory when asking permission,
so a later approval can deliver a verdict to that session. Capability projection
also forwards the hand-tool registry so `request_permission` can reach these tools.
The external MCP endpoint keeps its sessionless behavior.

All four new regressions failed before the fix. Afterward, 127 tests across seven
files passed, including approval delivery and external behavior. The strengthened
16-test runtime suite also proves no send occurs before consent and exactly one
send occurs after approval. Server typecheck, ESLint, formatting and diff checks
passed. The review found no other defects in the messaging changes.

OpenCode shares the tested authenticated tool server, but no live OpenCode model
turn was run. Startup also reported an existing missing Code-KG hook, and Relay's
agent-key sessions produced UUID warnings in the session-list broadcaster; neither
prevented the recorded exchanges. Those unrelated behaviors were not changed.

The code and validation report are prepared for a pull request in the fork.
The PR and deployment receipt track publication and installation separately.
