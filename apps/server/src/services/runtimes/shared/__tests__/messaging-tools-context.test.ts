import { describe, expect, it, vi } from 'vitest';
import { buildMessagingToolsBlock } from '../messaging/tools-context.js';
import { isRelayEnabled } from '../../../relay/relay-state.js';
vi.mock('../../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));

describe('runtime messaging guidance', () => {
  it.each(['mcp__dorkos__', 'dorkos_'])('uses the runtime prefix %s', (prefix) => {
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    const block = buildMessagingToolsBlock(prefix, []);
    expect(block).toContain(`${prefix}relay_send_and_wait`);
    expect(block).toContain(`${prefix}mesh_list`);
    expect(block).toContain('relaySubject exactly');
  });
  it('does not advertise blocked messaging or discovery areas', () => {
    expect(buildMessagingToolsBlock('test_', ['messages', 'agents'])).toBe('');
  });
  it('keeps discovery available when Relay is disabled', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const block = buildMessagingToolsBlock('test_', []);
    expect(block).toContain('<mesh_tools>');
    expect(block).not.toContain('<relay_tools>');
  });
});
