/**
 * Give background task and Relay turns the same session view as chat turns.
 *
 * Claim the turn queue and write lock before consuming the runtime stream.
 * Feed its events into the session projector so approvals, questions, and Stop
 * are available in the app. Follow canonical session renames with the lock and
 * projector, then withdraw pending interactions and release the claim on exit.
 *
 * The caller still owns runtime execution and cancellation.
 *
 * @module services/session/turn-identity/claim-session-turn
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { RuntimeCapabilities, SseResponse } from '@dorkos/shared/agent-runtime';
import {
  createCanonicalRekey,
  DetachedTurnLifecycle,
  feedProjector,
  getOrCreateProjector,
  persistenceModeFor,
  rekeyProjector,
  sessionTurnQueue,
  settleOpenTurnBefore,
  type SessionStateProjector,
} from '../index.js';
import { SESSIONS } from '../../../config/constants.js';
import { createTaggedLogger, logError } from '../../../lib/logger.js';

const logger = createTaggedLogger('SessionTurn');

/**
 * The lock identity every task run holds.
 *
 * One id for the whole scheduler, deliberately: it makes the scheduler's own
 * runs on one session queue behind each other, while a person's window — which
 * carries its own client id — contends through the LOCK instead, which is the
 * seam that actually crosses clients.
 */
export const TASK_RUN_CLIENT_ID = 'dorkos-task-scheduler';

/** Lock identity for agent messages opened through Relay. */
export const RELAY_TURN_CLIENT_ID = 'dorkos-relay';

/** How long a run waits for a session somebody else is using, before giving up. */
const SESSION_WAIT_MS = SESSIONS.LOCK_TTL_MS;

/** The beat between attempts to take a lock somebody else holds. */
const LOCK_RETRY_STEP_MS = 250;

/** What a run is failed with when the session never came free. */
export const SESSION_BUSY_ERROR =
  'This session stayed busy with another turn, so this turn could not start.';

/**
 * The runtime seams a run's turn needs. Every `AgentRuntime` satisfies it.
 *
 * `rekeyProjector` is deliberately NOT here: it is a module function, not a
 * runtime capability, and this module supplies it so a caller cannot wire a
 * rename that moves the lock but not the projector.
 */
export interface SessionTurnPort {
  /** The runtime's own id for a session key, once it has minted or kept one. */
  getInternalSessionId(sessionId: string): string | undefined;
  /** Take the session write-lock under an id. */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;
  /** Give back a lock this holder took. */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;
  /** End a turn the runtime left open. Absent for a runtime that cannot strand one. */
  settleOpenTurn?(sessionId: string): Promise<boolean>;
}

/** A run's claim on its session, for as long as its turn lasts. */
export interface SessionTurnClaim {
  /** Show one of the run's stream events to the session projection. */
  observe: (event: StreamEvent) => void;
  /**
   * Close the turn window, withdraw any ask nobody answered, and hand back the
   * lock and the chain slot.
   *
   * Safe to call more than once and never rejects: a projection that failed has
   * already been logged, and a run must be finalized on its own record whatever
   * the session surfaces did.
   */
  finish: () => Promise<void>;
}

/**
 * A hand-fed async iterable: push from a synchronous callback, close when done.
 *
 * `feedProjector` wants to OWN an `AsyncIterable`, and the run already owns the
 * runtime's stream (it has to — the stop race and the abandon-on-stop rule live
 * there). This is the seam between the two: the run pushes each event it has
 * already seen, and the projector's consumer pulls them in order.
 *
 * Single-consumer by construction, which is all this has: a second iterator
 * would steal buffered events from the first.
 */
function createPushableStream<T>(): {
  stream: AsyncIterable<T>;
  push: (value: T) => void;
  close: () => void;
  abandon: () => void;
} {
  const buffer: T[] = [];
  let closed = false;
  /** Resolves the consumer's idle wait; cleared as it fires so it arms once. */
  let wake: (() => void) | undefined;
  const notify = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  return {
    push(value: T): void {
      // Past the end there is nothing to push into: the stream is closing, or
      // the consumer has gone and an event buffered now would sit in an array
      // nothing will ever drain. A turn can run for an hour and produce
      // thousands of events, so "nobody is reading" has to mean "stop
      // buffering", never "buffer forever".
      if (closed) return;
      buffer.push(value);
      notify();
    },
    /** End the stream, letting the consumer drain what is already buffered. */
    close(): void {
      closed = true;
      notify();
    },
    /**
     * End the stream with nobody left to read it.
     *
     * The difference from {@link close} is the buffer: this is called when
     * `feedProjector` has already settled, so whatever is queued has no consumer
     * and dropping it is what keeps a failed projection from accumulating a
     * whole turn's events in memory.
     */
    abandon(): void {
      closed = true;
      buffer.length = 0;
      notify();
    },
    stream: {
      async *[Symbol.asyncIterator](): AsyncGenerator<T> {
        for (;;) {
          // Drained BEFORE the closed check, so a close that lands with events
          // still buffered delivers them rather than dropping them.
          while (buffer.length > 0) yield buffer.shift() as T;
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
}

/** Resolve after `ms`, without holding the process open for it. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/** Wait for work or cancellation, removing the listener on either outcome. */
async function waitForClaim(work: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await work;
    return true;
  }
  if (signal.aborted) return false;
  let onAbort!: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work.then(() => !signal.aborted), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Take the session write-lock, waiting for whoever holds it to be done.
 *
 * A person mid-turn in a sticky task's session is the case this exists for. A
 * normal dispatch REFUSES in that situation (a person gets a 409 and can try
 * again); a run has nobody to tell, so it waits instead — bounded by one lock
 * TTL, which is the longest a lock can be held without proof of life anyway.
 *
 * The wait parks on the projector's own turn-settled signal, so a run takes the
 * session the moment the turn ahead of it ends rather than on the next poll. The
 * beat before it is what keeps a lock held with NO turn open (a holder waiting
 * out its TTL) from spinning this loop.
 *
 * @returns Whether the lock was taken.
 */
async function acquireSessionLock(
  sessionId: string,
  projector: SessionStateProjector,
  deps: SessionTurnPort,
  holder: SseResponse,
  token: symbol,
  clientId: string,
  signal?: AbortSignal
): Promise<boolean> {
  const deadline = Date.now() + SESSION_WAIT_MS;
  for (;;) {
    if (signal?.aborted) return false;
    if (deps.acquireLock(sessionId, clientId, holder, token)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (!(await waitForClaim(delay(Math.min(LOCK_RETRY_STEP_MS, remaining)), signal))) return false;
    if (
      !(await waitForClaim(projector.awaitTurnSettled(Math.max(0, deadline - Date.now())), signal))
    )
      return false;
  }
}

/**
 * Claim the session for one attended run, and open its projection.
 *
 * Resolves only once the run may safely write to the session; the turn window is
 * open by the time it returns, so a card raised by the very first tool call
 * already has a projector behind it.
 *
 * @param opts.sessionId - The session this run's turn executes under.
 * @param opts.cwd - Where it runs. Required, not optional: the fleet-wide ask
 *   list skips any projector with no directory stamped on it, because the
 *   directory is the deep link and the name fallback — so a projection without
 *   one would be exactly as invisible as no projection at all.
 * @param opts.prompt - The task's prompt, carried on `turn_start` as the user
 *   side of the conversation (the run never POSTs a message, so this is the only
 *   place it can ride).
 * @param opts.capabilities - The resolved runtime's capabilities, which decide
 *   how much of the turn is worth storing durably. Absent for a runtime that
 *   declares no profile, which reads as "not log-backed" — the same answer, and
 *   the safer one, since it stores more rather than less.
 * @param opts.runtime - The runtime seams: the lock, the rename lookup and the
 *   optional stranded-turn settle.
 * @returns The claim, or `null` when the session never came free — the caller
 *   fails the run with {@link SESSION_BUSY_ERROR}.
 */
export async function claimSessionTurn(opts: {
  /** The background caller holding this turn. */
  clientId: string;
  signal?: AbortSignal;
  sessionId: string;
  cwd: string;
  prompt: string;
  capabilities: RuntimeCapabilities | undefined;
  runtime: SessionTurnPort;
}): Promise<SessionTurnClaim | null> {
  const { sessionId, runtime, clientId } = opts;
  // The id the lock and the chain are filed under. It starts as whatever the
  // runtime already resolves this session to and moves if the runtime renames it
  // mid-turn — the same rule, for the same reason, as a person's turn.
  let turnKey = runtime.getInternalSessionId(sessionId) ?? sessionId;

  const slot = sessionTurnQueue.reserve(turnKey, clientId, SESSION_WAIT_MS);
  if (!(await waitForClaim(slot.ready, opts.signal))) {
    slot.release();
    return null;
  }

  const projector = getOrCreateProjector(sessionId, opts.cwd, {
    persist: persistenceModeFor(opts.capabilities ?? {}),
  });
  // The lock is bound to a lifecycle, not to a request: a run has no response to
  // hang it on, and a run parked on an approval must not lose the session to the
  // lock's TTL while the person reads the card — which is what the
  // pending-interaction probe answers.
  const lifecycle = new DetachedTurnLifecycle(() => projector.hasPendingInteractions());
  const lockToken = Symbol('background-turn-lock');
  if (
    !(await acquireSessionLock(
      turnKey,
      projector,
      runtime,
      lifecycle,
      lockToken,
      clientId,
      opts.signal
    ))
  ) {
    slot.release();
    return null;
  }

  let released = false;
  const releaseClaim = (): void => {
    if (released) return;
    released = true;
    // `turnKey`, not the id we started with: a mid-turn rename moves the lock,
    // and the release has to target wherever it ended up.
    runtime.releaseLock(turnKey, clientId, lockToken);
    lifecycle.close();
    slot.release();
  };

  try {
    // Ordered exactly as a dispatch orders it — after the lock, so what gets
    // abandoned is a window stranded by construction and never a turn somebody
    // is still driving.
    await settleOpenTurnBefore(sessionId, projector, runtime, SESSIONS.STRANDED_TURN_SETTLE_MS);
  } catch {
    // `settleOpenTurnBefore` never rejects; this is belt-and-braces so a future
    // change there cannot strand a lock.
  }

  const tryRekey = createCanonicalRekey({
    sessionId,
    clientId,
    holder: lifecycle,
    lockToken,
    // Wrapped call-by-call, never spread: a runtime is a CLASS INSTANCE and its
    // methods live on the prototype, so `{ ...runtime }` copies none of them and
    // the first rekey dies with "getInternalSessionId is not a function". An
    // object-literal test double spreads perfectly well, which is exactly why
    // this shipped once and had to be found by running it. `turnDeps` in
    // `message-dispatcher.ts` builds its port the same way for the same reason.
    deps: {
      getInternalSessionId: (id) => runtime.getInternalSessionId(id),
      acquireLock: (sid, cid, res, token) => runtime.acquireLock(sid, cid, res, token),
      releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
      rekeyProjector,
    },
    chain: sessionTurnQueue,
    turnKey: () => turnKey,
    onTurnKey: (next) => {
      turnKey = next;
    },
  });

  const source = createPushableStream<StreamEvent>();
  // Never awaited here, and its failure never reaches the run: this is a second
  // view of a turn that is happening anyway, and a projection that threw must
  // not turn a run that worked into a run that failed. Closing the source in the
  // `finally` is what stops a dead consumer from collecting events forever.
  const fed = feedProjector(projector, source.stream, { userMessage: opts.prompt })
    .catch((err: unknown) => {
      logger.warn(`the session view of this run ended early (session ${sessionId})`, logError(err));
    })
    .finally(() => {
      // The consumer is gone — normally because `finish()` closed the stream and
      // it drained, but also when the projection threw mid-turn. Either way,
      // nothing will read another event.
      source.abandon();
    });

  return {
    observe: (event) => {
      lifecycle.touch();
      source.push(event);
      // Every event, until the rename lands — see `createCanonicalRekey` for why
      // one read at the first event is not enough.
      tryRekey();
    },
    finish: async (): Promise<void> => {
      source.close();
      await fed;
      // One more try: a turn that yielded nothing at all still renamed the
      // session, and the run row is about to name the id this settles on.
      tryRekey();
      // Withdraw anything the run was still being asked. A run halted, killed or
      // failed mid-ask leaves its card standing in every fleet-wide ask surface
      // for the four-hour park ceiling, pointing at a turn that is over — and
      // `turn_end` does not clear it, because a card genuinely outliving its turn
      // is the ordinary parked case. Nobody is coming back to THIS one.
      for (const pending of projector.getPendingInteractions()) {
        projector.resolveInteraction(pending.id);
      }
      releaseClaim();
    },
  };
}
