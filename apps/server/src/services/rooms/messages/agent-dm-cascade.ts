/** Durable limits for agent posts outside a DM turn. */
import {
  roomEntries,
  authors,
  eq,
  and,
  inArray,
  isNull,
  gt,
  desc,
  sql,
  count,
  type Db,
} from '@dorkos/db';

const MAX_AGENT_COLD_STARTS_PER_ROOM_PER_HOUR = 3;

/** The verified author and live conversation limits at the entry write boundary. */
export interface AgentDmCascadeInput {
  roomId: string;
  authorId: string;
  entryId: string;
  maxAgentDepth: number;
  maxTurnsPerAgentPerCascade: number;
  engagedMinutes: number;
  now: number;
}

/**
 * Join the latest DM cascade or spend one of three cold starts per room and author per hour.
 * Call under appendEntry's immediate transaction: reads and the insert share one write lock.
 * Persisted entries retain the bound across restarts and failed writes spend nothing.
 * @param db - The room database, already inside the entry transaction.
 * @param input - Verified posting identity and current limits.
 */
export function deriveAgentDmCascade(
  db: Db,
  input: AgentDmCascadeInput
): { cascadeRoot: string; cascadeDepth: number } {
  const {
    roomId,
    authorId,
    entryId,
    maxAgentDepth,
    maxTurnsPerAgentPerCascade,
    engagedMinutes,
    now,
  } = input;
  const latest = db
    .select({ root: roomEntries.cascadeRoot, createdAt: roomEntries.createdAt })
    .from(roomEntries)
    .innerJoin(authors, eq(authors.id, roomEntries.authorId))
    .where(
      and(
        eq(roomEntries.roomId, roomId),
        eq(roomEntries.kind, 'post'),
        inArray(authors.kind, ['human', 'agent'])
      )
    )
    .orderBy(desc(roomEntries.seq))
    .limit(1)
    .get();
  if (latest && Date.parse(latest.createdAt) > now - engagedMinutes * 60_000) {
    // Outside-turn posts spend the author's allowance too. Otherwise repeatedly
    // mentioning a SILENT peer could buy unlimited turns: that peer writes no
    // reply entries for the target-side repeat guard to count.
    const spent =
      db
        .select({
          value: sql<number>`COUNT(DISTINCT ${roomEntries.dispatchId}) + SUM(${roomEntries.dispatchId} IS NULL)`,
        })
        .from(roomEntries)
        .where(
          and(
            eq(roomEntries.roomId, roomId),
            eq(roomEntries.cascadeRoot, latest.root),
            eq(roomEntries.authorId, authorId)
          )
        )
        .get()?.value ?? 0;
    if (spent >= maxTurnsPerAgentPerCascade)
      return { cascadeRoot: latest.root, cascadeDepth: maxAgentDepth };
    // A late, shallow reply cannot rewind a chain that already advanced.
    const depth = db
      .select({ value: sql<number>`MAX(${roomEntries.cascadeDepth})` })
      .from(roomEntries)
      .where(and(eq(roomEntries.roomId, roomId), eq(roomEntries.cascadeRoot, latest.root)))
      .get();
    return { cascadeRoot: latest.root, cascadeDepth: depth?.value ?? maxAgentDepth };
  }
  const starts =
    db
      .select({ value: count() })
      .from(roomEntries)
      .where(
        and(
          eq(roomEntries.roomId, roomId),
          eq(roomEntries.authorId, authorId),
          eq(roomEntries.kind, 'post'),
          eq(roomEntries.cascadeRoot, roomEntries.id),
          eq(roomEntries.cascadeDepth, 1),
          isNull(roomEntries.dispatchId),
          gt(roomEntries.createdAt, new Date(now - 3_600_000).toISOString())
        )
      )
      .get()?.value ?? 0;
  return {
    cascadeRoot: entryId,
    cascadeDepth:
      starts < MAX_AGENT_COLD_STARTS_PER_ROOM_PER_HOUR ? Math.min(1, maxAgentDepth) : maxAgentDepth,
  };
}
