import { createTestDb } from '@dorkos/test-utils/db';
import { ApprovalService } from '../../../core/approvals/index.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import { composeRegistry, type CapabilityDeps } from '../../../core/capabilities/index.js';
import { permissionsDomain } from '../../../core/permissions/permission-capabilities.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { RelayCore, InboundTurnBudgets } from '@dorkos/relay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeCapabilityRegistryForDocs } from '../../../core/self-description/dorkos-registry.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import type { McpToolDeps } from '../../claude-code/mcp-tools/types.js';
import { resolveToolVisibility } from '../../shared/permission-tool-filter.js';
import { MCP_TOOL_TIERS } from '../../../core/mcp-tool-tiers.js';
import { createAgentRuntimeMcpServer } from '../agent-runtime-server.js';

const subject = 'relay.agent.team.agent-a';
const identity = { agentPath: '/agents/a', displayName: 'A', createdAt: '2026-10-01T00:00:00Z' };
const names = [
  'mesh_list',
  'mesh_inspect',
  'relay_send',
  'relay_send_async',
  'relay_send_and_wait',
  'relay_inbox',
];
const clients: Client[] = [];
const servers: ReturnType<typeof createAgentRuntimeMcpServer>[] = [];

function setupDeps() {
  const publish = vi.fn().mockResolvedValue({ messageId: 'message-a', deliveredTo: 1 });
  const readInbox = vi.fn().mockResolvedValue({ messages: [] });
  const inboundBudgets = new InboundTurnBudgets();
  const deps = {
    relayCore: { publish, readInbox, inboundBudgets, getEndpoint: (s: string) => ({ subject: s }) },
    meshCore: { getSubjectByPath: vi.fn(() => ({ subject, agentId: 'agent-a' })) },
  } as unknown as McpToolDeps;
  return { deps, publish, readInbox, inboundBudgets };
}

async function connect(
  runtime: 'codex' | 'opencode',
  deps: McpToolDeps,
  hidden = new Set<string>(),
  registry = composeCapabilityRegistryForDocs()
) {
  const principal = createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install-a' },
    bindingId: 'binding-a',
    runtime,
    canonicalSessionId: 'session-a',
    agentId: 'agent-a',
    agentPath: '/agents/a',
    canonicalCwd: '/worktree/a',
  });
  const server = createAgentRuntimeMcpServer(registry, principal, identity, hidden, deps);
  const client = new Client({ name: 'messaging-test', version: '1' });
  servers.push(server);
  clients.push(client);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return client;
}

beforeEach(() =>
  initPermissionGate({
    readConfig: () => ({ preset: 'full', defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => undefined,
  })
);
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  resetPermissionGate();
  resetCapabilityTierGate();
  vi.restoreAllMocks();
});

describe.each(['codex', 'opencode'] as const)('%s agent messaging', (runtime) => {
  it('advertises all six agent messaging tools and task tools', async () => {
    const client = await connect(runtime, setupDeps().deps);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([...names, 'tasks_list'])
    );
  });
  it('advertises honest safety metadata for unattended MCP calls', async () => {
    const client = await connect(runtime, setupDeps().deps);
    const tools = (await client.listTools()).tools;
    const annotations = (name: string) => tools.find((t) => t.name === name)?.annotations;
    for (const name of ['mesh_list', 'mesh_inspect', 'tasks_list']) {
      expect(annotations(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    for (const name of ['relay_send', 'relay_send_async', 'relay_send_and_wait']) {
      expect(annotations(name)).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
    }
    expect(annotations('relay_inbox')).toMatchObject({ readOnlyHint: false });
    expect(annotations('relay_notify_user')).toMatchObject({
      readOnlyHint: false,
      openWorldHint: true,
    });
    for (const name of ['relay_unregister_endpoint', 'mesh_unregister', 'tasks_delete']) {
      expect(annotations(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
    for (const tool of tools.filter((t) => /^(relay|mesh|tasks)_/.test(t.name))) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });
  it('sends as the principal agent and inherits the current session budget at call time', async () => {
    const { deps, publish, inboundBudgets } = setupDeps();
    const client = await connect(runtime, deps);
    inboundBudgets.bind('session-a', {
      hopCount: 2,
      maxHops: 3,
      ancestorChain: [],
      ttl: Date.now() + 60000,
      callBudgetRemaining: 4,
    });
    const result = await client.callTool({
      name: 'relay_send',
      arguments: { subject: 'relay.agent.team.b', payload: 'hello' },
    });
    expect(result.isError).not.toBe(true);
    expect(publish).toHaveBeenCalledWith(
      'relay.agent.team.b',
      'hello',
      expect.objectContaining({
        from: subject,
        budget: expect.objectContaining({ hopCount: 2, maxHops: 3, callBudgetRemaining: 4 }),
      })
    );
    expect(deps.meshCore!.getSubjectByPath).toHaveBeenCalledWith('/agents/a');
  });
  it.each(['direct', 'request'] as const)(
    'addresses %s approval verdicts to the canonical runtime session',
    async (route) => {
      const approvals = new ApprovalService(createTestDb());
      initCapabilityTierGate({ approvals });
      const request = vi.spyOn(approvals, 'request');
      initPermissionGate({
        readConfig: () => ({
          preset: 'full',
          defaults: { areas: { messages: route === 'direct' ? 'ask' : 'blocked' }, actions: {} },
        }),
        readAgentPermissions: async () => undefined,
      });
      const registryDeps: CapabilityDeps = {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      };
      const registry = composeRegistry([permissionsDomain], registryDeps);
      registryDeps.registry = registry;
      const { deps, publish } = setupDeps();
      const client = await connect(
        runtime,
        deps,
        new Set(route === 'request' ? ['relay_send'] : []),
        registry
      );
      const args = { subject: 'relay.agent.team.b', payload: 'requires consent' };
      const result = await client.callTool(
        route === 'direct'
          ? { name: 'relay_send', arguments: args }
          : {
              name: 'request_permission',
              arguments: {
                action: 'relay_send',
                arguments: args,
                reason: 'Ask my teammate for help.',
              },
            }
      );
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.approvalId, JSON.stringify(payload)).toBeTruthy();
      expect(publish).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          requestingSession: { sessionId: 'session-a', cwd: '/worktree/a' },
        })
      );
      approvals.grant(payload.approvalId);
      expect(approvals.verdictDelivery(payload.approvalId)).toMatchObject({
        sessionId: 'session-a',
        cwd: '/worktree/a',
        verdict: { outcome: 'granted' },
      });
      await client.callTool(
        route === 'direct'
          ? { name: 'relay_send', arguments: { ...args, approvalToken: payload.approvalToken } }
          : {
              name: 'request_permission',
              arguments: {
                action: 'relay_send',
                arguments: args,
                reason: 'Ask my teammate for help.',
                approvalToken: payload.approvalToken,
              },
            }
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        args.subject,
        args.payload,
        expect.objectContaining({ from: subject })
      );
    }
  );
  it('reads its own inbox and refuses another agent inbox', async () => {
    const { deps, readInbox } = setupDeps();
    const client = await connect(runtime, deps);
    expect(
      (await client.callTool({ name: 'relay_inbox', arguments: { endpoint_subject: subject } }))
        .isError
    ).not.toBe(true);
    const refused = await client.callTool({
      name: 'relay_inbox',
      arguments: { endpoint_subject: 'relay.agent.team.b', ack: true },
    });
    expect(JSON.stringify(refused)).toContain('ENDPOINT_ACCESS_DENIED');
    expect(readInbox).toHaveBeenCalledTimes(1);
  });
  it('completes a real Relay query and stops sends at the inherited hop limit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'runtime-relay-'));
    const delivered: RelayEnvelope[] = [];
    const relay = new RelayCore({
      dataDir: dir,
      adapterRegistry: {
        setRelay() {},
        async deliver(to, envelope) {
          if (to !== 'relay.agent.team.b') return null;
          delivered.push(envelope);
          if (envelope.replyTo)
            await relay.publish(
              envelope.replyTo,
              { type: 'agent_result', text: 'received', done: true },
              {
                from: to,
                budget: { ...envelope.budget, hopCount: envelope.budget.hopCount + 1 },
              }
            );
          return { success: true, durationMs: 0 };
        },
        async shutdown() {},
      },
    });
    try {
      const { deps } = setupDeps();
      deps.relayCore = relay;
      const client = await connect(runtime, deps);
      const reply = await client.callTool({
        name: 'relay_send_and_wait',
        arguments: {
          to_subject: 'relay.agent.team.b',
          payload: 'question',
          timeout_ms: 1000,
        },
      });
      expect(reply.isError).not.toBe(true);
      expect(JSON.stringify(reply)).toContain('received');
      expect(delivered).toHaveLength(1);
      expect(delivered[0].from).toBe(subject);
      relay.inboundBudgets.bind('session-a', {
        hopCount: 3,
        maxHops: 3,
        ancestorChain: [],
        ttl: Date.now() + 60000,
        callBudgetRemaining: 1,
      });
      const refused = await client.callTool({
        name: 'relay_send',
        arguments: {
          subject: 'relay.agent.team.b',
          payload: 'one hop too far',
          budget: { maxHops: 100, callBudgetRemaining: 100 },
        },
      });
      expect(refused.isError).toBe(true);
      expect(delivered).toHaveLength(1);
    } finally {
      await relay.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('hides blocked Relay tools and enforces permission changes on calls', async () => {
    const { deps, publish } = setupDeps();
    const beforeBlock = await connect(runtime, deps);
    initPermissionGate({
      readConfig: () => ({
        preset: 'full',
        defaults: { areas: { messages: 'blocked' }, actions: {} },
      }),
      listActions: () =>
        Object.entries(MCP_TOOL_TIERS).map(([id, rule]) => ({
          id,
          tier: rule.tier,
          area: 'area' in rule ? rule.area : null,
          toolName: id,
        })),
    });
    const client = await connect(
      runtime,
      deps,
      new Set(resolveToolVisibility(undefined).hiddenToolNames)
    );
    const refused = await beforeBlock.callTool({
      name: 'relay_send',
      arguments: { subject: 'relay.agent.team.b', payload: 'blocked' },
    });
    expect(JSON.stringify(refused)).toContain('blocked');
    expect(publish).not.toHaveBeenCalled();
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toContain('mesh_list');
    for (const name of names.filter((n) => n.startsWith('relay_')))
      expect(listed).not.toContain(name);
  });
});
