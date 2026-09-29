import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../src/sessions/index.js';
import { PromptHandler } from '../src/sessions/prompt.js';
import { PermissionEngine } from '../src/permissions/index.js';
import type { McacpConfig } from '../src/types/config.js';
import type { LifecycleManager, AgentHandle } from '../src/acp/lifecycle.js';
import type { SessionConfigOption } from '../src/types/acp.js';

function makeConfig(sessionDir: string): McacpConfig {
  return {
    registries: [],
    agent_servers: {},
    defaultAutoReapMs: 300000,
    defaultPermissionPolicy: 'elicit',
    sessionDir,
    installDir: './.mcacp/agents',
    promptConsolidateMs: 0,
    heartbeatTimeoutMs: 60000,
    collectFeedback: false,
    feedbackFile: './.mcacp/feedback.md',
    clientInfo: { name: 'mcacp', version: '0.1.0', title: 'MCACP Bridge' },
  };
}

const modelOption = (): SessionConfigOption => ({
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet',
  options: [
    { value: 'sonnet', name: 'Sonnet' },
    { value: 'opus', name: 'Opus' },
  ],
});

const thoughtOption = (): SessionConfigOption => ({
  id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'medium',
  options: [{
    group: 'levels', name: 'Levels',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  }],
});

describe('session settings', () => {
  let tempDir: string;
  let config: McacpConfig;
  let handle: AgentHandle;
  let request: ReturnType<typeof vi.fn>;
  let lifecycle: LifecycleManager;
  let mgr: SessionManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mcacp-settings-'));
    config = makeConfig(tempDir);
    request = vi.fn();
    handle = {
      agentId: 'agent-1',
      transport: { request, notify: vi.fn(), setNotificationHandler: vi.fn(), setRequestHandler: vi.fn() } as any,
      capabilities: {},
      protocolVersion: 1,
      activeSessions: new Set<string>(),
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      reapTimer: null,
      status: { text: 'initialized', updatedAt: Date.now() },
    } as AgentHandle;
    lifecycle = {
      getAgent: vi.fn(() => handle),
      touchActivity: vi.fn(),
    } as unknown as LifecycleManager;
    mgr = new SessionManager(config, lifecycle);
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('newSession returns modes, models, and config options from the agent', async () => {
    request.mockResolvedValueOnce({
      sessionId: 's1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }], currentModeId: 'default' },
      configOptions: [modelOption()],
    });
    const result = await mgr.newSession('agent-1', '/work');
    expect(result.sessionId).toBe('s1');
    expect(result.modes?.currentModeId).toBe('default');
    expect(result.configOptions?.[0].id).toBe('model');
    expect(result.permissionPolicy).toBe('elicit');
  });

  it('newSession uses the per-agent permission policy from config', async () => {
    config.agent_servers['agent-1'] = { permissionPolicy: 'operator' };
    request.mockResolvedValueOnce({ sessionId: 's1' });
    const result = await mgr.newSession('agent-1', '/work');
    expect(result.permissionPolicy).toBe('operator');
  });

  it('setModel uses session/set_config_option when a model option exists', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1', configOptions: [modelOption()] });
    await mgr.newSession('agent-1', '/work');

    const updated = { ...modelOption(), currentValue: 'opus' };
    request.mockResolvedValueOnce({ configOptions: [updated] });
    const result = await mgr.setModel('s1', 'Opus');

    expect(request).toHaveBeenLastCalledWith('session/set_config_option', {
      sessionId: 's1', configId: 'model', value: 'opus',
    });
    expect(result.configOptions?.[0].currentValue).toBe('opus');
  });

  it('setModel falls back to session/set_model with legacy models state', async () => {
    request.mockResolvedValueOnce({
      sessionId: 's1',
      models: {
        availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }, { modelId: 'opus', name: 'Opus' }],
        currentModelId: 'sonnet',
      },
    });
    await mgr.newSession('agent-1', '/work');
    request.mockResolvedValueOnce({});

    const result = await mgr.setModel('s1', 'opus');
    expect(request).toHaveBeenLastCalledWith('session/set_model', { sessionId: 's1', modelId: 'opus' });
    expect(result.models?.currentModelId).toBe('opus');
  });

  it('setModel rejects unknown models with the list of valid ones', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1', configOptions: [modelOption()] });
    await mgr.newSession('agent-1', '/work');
    await expect(mgr.setModel('s1', 'gpt')).rejects.toThrow(/Valid values: sonnet \(Sonnet\), opus \(Opus\)/);
  });

  it('setModel errors when the agent advertises no model selection', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1' });
    await mgr.newSession('agent-1', '/work');
    await expect(mgr.setModel('s1', 'opus')).rejects.toThrow(/does not advertise model selection/);
  });

  it('setThinkingLevel resolves grouped options and falls back to local update', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1', configOptions: [modelOption(), thoughtOption()] });
    await mgr.newSession('agent-1', '/work');
    request.mockResolvedValueOnce(null);

    const result = await mgr.setThinkingLevel('s1', 'HIGH');
    expect(request).toHaveBeenLastCalledWith('session/set_config_option', {
      sessionId: 's1', configId: 'effort', value: 'high',
    });
    expect(result.configOptions?.find(o => o.id === 'effort')?.currentValue).toBe('high');
  });

  it('setThinkingLevel finds uncategorised options by name', async () => {
    const opt = { ...thoughtOption(), category: undefined, id: 'reasoning_effort' };
    request.mockResolvedValueOnce({ sessionId: 's1', configOptions: [opt] });
    await mgr.newSession('agent-1', '/work');
    request.mockResolvedValueOnce(null);
    await mgr.setThinkingLevel('s1', 'low');
    expect(request).toHaveBeenLastCalledWith('session/set_config_option', {
      sessionId: 's1', configId: 'reasoning_effort', value: 'low',
    });
  });

  it('setThinkingLevel errors when unsupported', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1', configOptions: [modelOption()] });
    await mgr.newSession('agent-1', '/work');
    await expect(mgr.setThinkingLevel('s1', 'high')).rejects.toThrow(/thinking level/);
  });

  it('applySettingsUpdate tracks config_option_update and current_mode_update', async () => {
    request.mockResolvedValueOnce({
      sessionId: 's1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], currentModeId: 'default' },
      configOptions: [modelOption()],
    });
    await mgr.newSession('agent-1', '/work');
    const session = mgr.getSession('s1');

    mgr.applySettingsUpdate(session, {
      sessionUpdate: 'config_option_update', configOptions: [{ ...modelOption(), currentValue: 'opus' }],
    });
    mgr.applySettingsUpdate(session, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } as any);

    const settings = mgr.getSettings('s1');
    expect(settings.configOptions?.[0].currentValue).toBe('opus');
    expect(settings.modes?.currentModeId).toBe('plan');
  });

  it('setPermissionPolicy updates the session and persists it', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1' });
    await mgr.newSession('agent-1', '/work');
    const result = mgr.setPermissionPolicy('s1', 'deny_all');
    expect(result.permissionPolicy).toBe('deny_all');
    const file = JSON.parse(readFileSync(join(tempDir, 'agent-1', 'sessions', 's1.json'), 'utf-8'));
    expect(file.permissionPolicy).toBe('deny_all');
  });

  it('PromptHandler.setPermissionPolicy resolves a pending permission for allow_all', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1' });
    await mgr.newSession('agent-1', '/work');
    const handler = new PromptHandler(lifecycle, mgr, new PermissionEngine(), config);
    const session = mgr.getSession('s1');
    const resolve = vi.fn();
    session.pendingPermission = {
      toolCallId: 't1', title: 'Edit file',
      options: [
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      ],
      resolve,
    };

    handler.setPermissionPolicy('s1', 'allow_all');
    expect(resolve).toHaveBeenCalledWith({ selected: { optionId: 'yes' } });
    expect(session.pendingPermission).toBeNull();
  });

  it('PromptHandler.setPermissionPolicy leaves a pending permission for operator', async () => {
    request.mockResolvedValueOnce({ sessionId: 's1' });
    await mgr.newSession('agent-1', '/work');
    const handler = new PromptHandler(lifecycle, mgr, new PermissionEngine(), config);
    const session = mgr.getSession('s1');
    const resolve = vi.fn();
    session.pendingPermission = { toolCallId: 't1', title: 'x', options: [], resolve };

    handler.setPermissionPolicy('s1', 'operator');
    expect(resolve).not.toHaveBeenCalled();
    expect(session.pendingPermission).not.toBeNull();
  });

  it('setMode updates the tracked current mode', async () => {
    request.mockResolvedValueOnce({
      sessionId: 's1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }], currentModeId: 'default' },
    });
    await mgr.newSession('agent-1', '/work');
    const handler = new PromptHandler(lifecycle, mgr, new PermissionEngine(), config);
    request.mockResolvedValueOnce({});
    await handler.setMode('s1', 'plan');
    expect(mgr.getSettings('s1').modes?.currentModeId).toBe('plan');
  });

  it('setMode also updates the mode config option', async () => {
    const modeOption: SessionConfigOption = {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
    };
    request.mockResolvedValueOnce({ sessionId: 's1', configOptions: [modeOption] });
    await mgr.newSession('agent-1', '/work');
    const handler = new PromptHandler(lifecycle, mgr, new PermissionEngine(), config);
    request.mockResolvedValueOnce({});
    await handler.setMode('s1', 'plan');
    expect(mgr.getSettings('s1').configOptions?.[0].currentValue).toBe('plan');
  });
});
