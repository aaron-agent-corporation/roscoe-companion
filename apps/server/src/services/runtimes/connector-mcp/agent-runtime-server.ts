/** Agent-safe DorkOS capabilities projected onto the authenticated runtime listener. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import { registerCapabilitiesAsMcpTools } from '../../core/external-mcp/capability-mcp-tools.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import { gatedToolRegistrar } from '../../core/mcp-tool-gate.js';
import type { McpToolName } from '../../core/mcp-tool-tiers.js';
import { ToolAnnotationPresets } from '../../core/mcp-tool-metadata.js';
import { RELAY_EXTERNAL_CONFIGS } from '../../core/external-mcp/relay-tools.js';
import { MESH_EXTERNAL_CONFIGS } from '../../core/external-mcp/mesh-tools.js';
import { TASKS_EXTERNAL_CONFIGS } from '../../core/external-mcp/task-tools.js';
import type { ExternalToolConfigs } from '../../core/external-mcp/register-from-definitions.js';
import type { McpToolDeps } from '../claude-code/mcp-tools/types.js';
import { getRelayTools } from '../claude-code/mcp-tools/relay-tools.js';
import { getMeshTools } from '../claude-code/mcp-tools/mesh-tools.js';
import { getTasksTools } from '../claude-code/mcp-tools/task-tools.js';
import { resolveSenderIdentity } from '../claude-code/mcp-tools/relay-helpers.js';
import { SERVER_VERSION } from '../../../lib/version.js';

// The same handlers have the same safety semantics on either HTTP listener.
// Only annotations are reused: the external allowlist and output schemas do
// not decide which tools an authenticated agent receives.
const TOOL_METADATA: ExternalToolConfigs = {
  ...RELAY_EXTERNAL_CONFIGS,
  ...MESH_EXTERNAL_CONFIGS,
  ...TASKS_EXTERNAL_CONFIGS,
  relay_notify_user: { annotations: ToolAnnotationPresets.mutateCreateOpenWorld },
};

/**
 * Build the DorkOS capability server for one authenticated runtime turn.
 *
 * Capabilities explicitly marked for the existing `in-session` audience
 * are registered alongside the same gated Relay, Mesh and Tasks definitions
 * used in Claude Code. External-only capabilities never reach this boundary.
 * The verified turn supplies every caller fact; no header or tool argument can select another agent, session, or
 * directory.
 *
 * @param registry - Fully composed server capability registry.
 * @param principal - Turn-bound principal resolved by the loopback listener.
 * @param identity - Active agent identity resolved from the principal's path.
 * @param hiddenToolNames - Tools this agent is not shown because their permission
 *   resolves to Blocked (spec `agent-permissions` D15).
 * @param deps - Shared Relay, Mesh and Tasks dependencies from server startup.
 * @returns MCP server whose handlers retain the authenticated turn context.
 */
export function createAgentRuntimeMcpServer(
  registry: CapabilityRegistry,
  principal: ServerPrincipalProof,
  identity: AgentIdentity,
  hiddenToolNames: ReadonlySet<string> = new Set(),
  deps?: McpToolDeps
): McpServer {
  if (principal.claims.kind !== 'runtime') {
    throw new Error('Agent runtime tools require a runtime principal.');
  }

  const server = new McpServer({ name: 'dorkos', version: SERVER_VERSION });
  const registrar = gatedToolRegistrar(server, identity, hiddenToolNames, {
    sessionId: principal.claims.canonicalSessionId,
    cwd: principal.claims.canonicalCwd,
  });
  if (deps) {
    const { agentPath, canonicalSessionId } = principal.claims;
    // The authenticated agent's home, never the working directory or tool arguments.
    const sender =
      deps.meshCore?.getSubjectByPath(agentPath) ?? resolveSenderIdentity(deps, agentPath);
    const definitions = [
      ...getRelayTools(deps, sender, () => deps.relayCore?.inboundBudgets.get(canonicalSessionId)),
      ...getMeshTools(deps),
      ...getTasksTools(deps, () => ({ agentPath, sessionId: canonicalSessionId })),
    ];
    for (const definition of definitions) {
      const metadata = TOOL_METADATA[definition.name as McpToolName];
      if (!metadata) {
        throw new Error(`Missing runtime MCP safety metadata for ${definition.name}`);
      }
      registrar.registerTool(
        definition.name,
        {
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: metadata.annotations,
        },
        definition.handler as never
      );
    }
  }
  registerCapabilitiesAsMcpTools(
    server,
    registry,
    'in-session',
    {
      identity,
      handTools: registrar.reach,
      agentIdentityPresented: true,
      sessionId: principal.claims.canonicalSessionId,
      cwd: principal.claims.agentPath,
      serverPrincipal: principal,
    },
    hiddenToolNames
  );
  return server;
}
