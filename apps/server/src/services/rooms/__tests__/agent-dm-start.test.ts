import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentLookupFor, createRoomHarness, scriptedRunner } from './room-test-harness.js';

function setup(kind: 'dm' | 'channel' = 'dm', minutes = 10, silent = false) {
  const h = createRoomHarness({
    agents: agentLookupFor({
      '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'always' },
      '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'always' },
    }),
    runner: scriptedRunner((r) =>
      silent ? null : r.authorId === ana ? 'done' : '@ana please review'
    ),
    maxAgentDepth: 30,
    maxTurnsPerAgentPerCascade: 3,
    engagedWindow: { minutes, posts: 5 },
  });
  const room = h.service.createRoom(
    { kind, title: 'Team', members: [], agentPaths: ['/agents/ana', '/agents/bo'] },
    h.human
  );
  const ana = h.authors.resolveAgent('/agents/ana', 'Ana').id;
  const bo = h.authors.resolveAgent('/agents/bo', 'Bo').id;
  const post = (text = '@bo review this') => h.service.post(room.id, { authorId: ana, text });
  const log = () => h.service.listEntries(room.id, h.human, { limit: 200 });
  return { ...h, room, ana, bo, post, log };
}

afterEach(() => vi.useRealTimers());

describe('agent posts outside a DM turn', () => {
  it('starts at depth one, wakes the mentioned agent and allows its reply to wake the author', async () => {
    const h = setup();
    const first = h.post();
    await h.service.triggersIdle();
    expect(first.cascadeDepth).toBe(1);
    expect(h.runner.turns.map((t) => t.authorId)).toEqual([h.bo, h.ana]);
    expect(
      h
        .log()
        .filter((e) => e.kind === 'post')
        .map((e) => e.cascadeRoot)
    ).toEqual([first.id, first.id, first.id]);
  });
  it('keeps thirty outside-turn posts on one cascade and bounds replies', async () => {
    const h = setup();
    const roots = new Set<string>();
    for (let i = 0; i < 30; i++) {
      roots.add(h.post().cascadeRoot);
      await h.service.triggersIdle();
    }
    expect(roots.size).toBe(1);
    expect(h.runner.turns.length).toBeGreaterThan(0);
    expect(h.runner.turns.length).toBeLessThanOrEqual(6);
  });
  it('bounds repeated mentions even when the target takes silent turns', async () => {
    const h = setup('dm', 10, true);
    for (let i = 0; i < 30; i++) {
      h.post();
      await h.service.triggersIdle();
    }
    expect(h.runner.turns).toHaveLength(3);
  });
  it('never rewinds a recent cascade when a shallower reply arrives late', async () => {
    const h = setup();
    const seed = h.post();
    await h.service.triggersIdle();
    h.service.post(h.room.id, {
      authorId: h.bo,
      text: 'deep reply',
      trigger: { root: seed.id, depth: 12 },
    });
    h.service.post(h.room.id, {
      authorId: h.bo,
      text: 'late shallow reply',
      trigger: { root: seed.id, depth: 2 },
    });
    const joined = h.post();
    await h.service.triggersIdle();
    expect(joined.cascadeRoot).toBe(seed.id);
    expect(joined.cascadeDepth).toBe(12);
  });
  it('bounds fresh roots even with a zero-minute engagement window', async () => {
    const h = setup('dm', 0);
    const depths: number[] = [];
    for (let i = 0; i < 30; i++) {
      depths.push(h.post().cascadeDepth);
      await h.service.triggersIdle();
    }
    expect(depths.filter((d) => d === 1)).toHaveLength(3);
    expect(depths.slice(3)).toEqual(Array(27).fill(30));
    expect(h.runner.turns.length).toBeLessThanOrEqual(6);
  });
  it('does not wake agents for an unaddressed DM post', async () => {
    const h = setup();
    h.post('progress update');
    await h.service.triggersIdle();
    expect(h.runner.turns).toHaveLength(0);
    expect(h.log().filter((e) => e.kind === 'notice')).toHaveLength(0);
  });
  it('caps cold starts at three per author per room in a rolling hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const h = setup('dm', 1);
    for (let i = 0; i < 3; i++) {
      expect(h.post().cascadeDepth).toBe(1);
      await h.service.triggersIdle();
      vi.setSystemTime(Date.now() + 2 * 60000);
    }
    expect(h.post().cascadeDepth).toBe(30);
    await h.service.triggersIdle();
    vi.setSystemTime(Date.now() + 61 * 60000);
    expect(h.post().cascadeDepth).toBe(1);
    await h.service.triggersIdle();
  });
  it('keeps channels bounded and explains mentions once per author per room per hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    const h = setup('channel');
    for (let i = 0; i < 5; i++) h.post();
    await h.service.triggersIdle();
    expect(h.runner.turns).toHaveLength(0);
    expect(h.log().filter((e) => e.kind === 'notice')).toHaveLength(1);
    expect(h.log().find((e) => e.kind === 'notice')!.body.text).toContain('outside a room turn');
    vi.setSystemTime(Date.now() + 61 * 60000);
    h.post();
    await h.service.triggersIdle();
    expect(h.log().filter((e) => e.kind === 'notice')).toHaveLength(2);
  });
});
