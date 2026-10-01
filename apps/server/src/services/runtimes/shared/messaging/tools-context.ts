/** Agent messaging guidance for runtimes using the authenticated MCP listener. */
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { isRelayEnabled } from '../../../relay/relay-state.js';

/**
 * Explain the messaging tools actually available to this turn.
 * @param prefix - The calling runtime's MCP tool prefix.
 * @param blockedAreas - Permission areas hidden from this agent.
 */
export function buildMessagingToolsBlock(
  prefix: string,
  blockedAreas: readonly PermissionAreaId[]
): string {
  const blocks: string[] = [];
  if (!blockedAreas.includes('agents')) {
    blocks.push(`<mesh_tools>
Use ${prefix}mesh_list to find other agents and ${prefix}mesh_inspect for their details.
Copy their relaySubject exactly when sending a message; do not construct an address yourself.
</mesh_tools>`);
  }
  if (isRelayEnabled() && !blockedAreas.includes('messages')) {
    blocks.push(`<relay_tools>
Your agent messaging tools are already in your tool list.
Use ${prefix}relay_send_and_wait(to_subject, payload, timeout_ms) to ask another agent and wait for its reply (up to 600000 ms).
Use ${prefix}relay_send_async(to_subject, payload) for longer work, then read its returned inboxSubject with ${prefix}relay_inbox(endpoint_subject, ack=true).
Use ${prefix}relay_send(subject, payload) for a message that needs no waiting.
Sends carry your own agent identity and inherit the current conversation's hop, time and call limits.
You can read only your own inbox or an inbox returned by your async send. Acknowledging messages deletes their payloads.
Check replies for errors before treating them as completed work. Do not retry a budget refusal to restart a chain.
</relay_tools>`);
  }
  return blocks.join('\n\n');
}
