import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, sep, dirname } from 'node:path';
import type { McacpConfig, PermissionPolicy } from '../types/config.js';
import type {
  SessionId, SessionNewResult, SessionLoadResult, McpServer, SessionUpdate, StopReason,
  SessionModeState, SessionModelState, SessionConfigOption, SessionSetConfigOptionResult,
  SessionConfigValue,
} from '../types/acp.js';
import { LifecycleManager } from '../acp/lifecycle.js';
import { getAgentConfig } from '../config/index.js';
import { findOptionByCategory, resolveChoice } from './config-options.js';

/** Snapshot of a session's selectable settings as last reported by the agent. */
export interface SessionSettings {
  sessionId: SessionId;
  agentId: string;
  permissionPolicy: PermissionPolicy;
  modes?: SessionModeState;
  models?: SessionModelState;
  configOptions?: SessionConfigOption[];
}

export interface SessionFile {
  sessionId: SessionId;
  agentId: string;
  cwd: string;
  permissionPolicy: PermissionPolicy;
  createdAt: string;
  lastActiveAt: string;
  closedAt?: string;
  metadata?: Record<string, unknown>;
}

export type PromptState = 'idle' | 'prompted';

export type BarePromptEvent =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission_request'; toolCallId: string; title: string; options: Array<{ optionId: string; name: string; kind: string }> }
  | { type: 'complete'; stopReason: StopReason }
  | { type: 'error'; message: string };

export type PromptEvent = BarePromptEvent & {
  sessionId: SessionId;
  agentId: string;
};

export interface ActiveSession {
  sessionId: SessionId;
  agentId: string;
  permissionPolicy: PermissionPolicy;
  pendingPermission: PendingPermission | null;
  promptState: PromptState;
  eventQueue: PromptEvent[];
  waiters: Array<(events: PromptEvent[]) => void>;
  /** Accumulated text for Nagle-style chunk consolidation */
  chunkBuffer: { text: string; updateType: string } | null;
  /** Pending flush timer for chunk consolidation */
  chunkTimer: ReturnType<typeof setTimeout> | null;
  modes?: SessionModeState;
  models?: SessionModelState;
  configOptions?: SessionConfigOption[];
}

export interface PendingPermission {
  toolCallId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  resolve: (outcome: { selected: { optionId: string } } | { cancelled: Record<string, never> }) => void;
}

export class SessionManager {
  private activeSessions = new Map<SessionId, ActiveSession>();

  constructor(
    private config: McacpConfig,
    private lifecycle: LifecycleManager,
  ) {}

  async newSession(
    agentId: string, cwd: string, mcpServers?: McpServer[], permissionPolicy?: PermissionPolicy,
  ): Promise<SessionSettings> {
    const handle = this.lifecycle.getAgent(agentId);
    const policy = permissionPolicy ?? getAgentConfig(this.config, agentId).permissionPolicy;
    const result = await handle.transport.request('session/new', {
      cwd, mcpServers: mcpServers ?? [],
    }) as SessionNewResult;

    this.activeSessions.set(result.sessionId, {
      sessionId: result.sessionId, agentId, permissionPolicy: policy, pendingPermission: null,
      promptState: 'idle', eventQueue: [], waiters: [],
      chunkBuffer: null, chunkTimer: null,
      modes: result.modes, models: result.models, configOptions: result.configOptions,
    });
    handle.activeSessions.add(result.sessionId);
    this.saveSessionFile({
      sessionId: result.sessionId, agentId, cwd, permissionPolicy: policy,
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
    });
    this.lifecycle.touchActivity(agentId);
    return this.getSettings(result.sessionId);
  }

  async loadSession(
    agentId: string, sessionId: SessionId, cwd: string, mcpServers?: McpServer[],
  ): Promise<SessionSettings> {
    const handle = this.lifecycle.getAgent(agentId);
    if (!handle.capabilities.loadSession) {
      throw new Error(`Agent "${agentId}" does not support loading sessions`);
    }
    const result = await handle.transport.request('session/load', {
      sessionId, cwd, mcpServers: mcpServers ?? [],
    }) as SessionLoadResult;

    const file = this.readSessionFile(agentId, sessionId);
    const policy = file?.permissionPolicy ?? getAgentConfig(this.config, agentId).permissionPolicy;
    this.activeSessions.set(sessionId, {
      sessionId, agentId, permissionPolicy: policy, pendingPermission: null,
      promptState: 'idle', eventQueue: [], waiters: [],
      chunkBuffer: null, chunkTimer: null,
      modes: result?.modes, models: result?.models, configOptions: result?.configOptions,
    });
    handle.activeSessions.add(sessionId);
    this.saveSessionFile({
      sessionId, agentId, cwd, permissionPolicy: policy,
      createdAt: file?.createdAt ?? new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    });
    this.lifecycle.touchActivity(agentId);
    return this.getSettings(sessionId);
  }

  getSettings(sessionId: SessionId): SessionSettings {
    const s = this.getSession(sessionId);
    return {
      sessionId: s.sessionId, agentId: s.agentId, permissionPolicy: s.permissionPolicy,
      modes: s.modes, models: s.models, configOptions: s.configOptions,
    };
  }

  /** Set an agent-defined config option (session/set_config_option). */
  async setConfigOption(sessionId: SessionId, configId: string, value: SessionConfigValue): Promise<SessionSettings> {
    const session = this.getSession(sessionId);
    const option = session.configOptions?.find(o => o.id === configId);
    const resolved = option ? resolveChoice(option, value) : value;
    const handle = this.lifecycle.getAgent(session.agentId);
    // Boolean values must be tagged with type: "boolean"; select values are sent bare.
    const result = await handle.transport.request('session/set_config_option', typeof resolved === 'boolean'
      ? { sessionId, configId, type: 'boolean', value: resolved }
      : { sessionId, configId, value: resolved },
    ) as SessionSetConfigOptionResult | null;
    if (result?.configOptions) {
      session.configOptions = result.configOptions;
    } else if (option) {
      // resolveChoice returns a boolean for boolean options and a string for selects
      (option as { currentValue: SessionConfigValue }).currentValue = resolved;
    }
    this.syncFromConfigOptions(session);
    this.lifecycle.touchActivity(session.agentId);
    return this.getSettings(sessionId);
  }

  /**
   * Select the session's model. Uses the "model" config option when the agent
   * advertises one, otherwise the older session/set_model method.
   */
  async setModel(sessionId: SessionId, model: string): Promise<SessionSettings> {
    const session = this.getSession(sessionId);
    const option = findOptionByCategory(session.configOptions, 'model');
    if (option) return this.setConfigOption(sessionId, option.id, model);

    if (!session.models) {
      throw new Error(`Agent "${session.agentId}" does not advertise model selection for this session`);
    }
    const match = session.models.availableModels.find(m => m.modelId === model)
      ?? session.models.availableModels.find(m =>
        m.modelId.toLowerCase() === model.toLowerCase() || m.name.toLowerCase() === model.toLowerCase());
    if (!match) {
      const valid = session.models.availableModels.map(m => m.modelId).join(', ');
      throw new Error(`"${model}" is not an available model. Available models: ${valid}`);
    }
    const handle = this.lifecycle.getAgent(session.agentId);
    await handle.transport.request('session/set_model', { sessionId, modelId: match.modelId });
    session.models.currentModelId = match.modelId;
    this.lifecycle.touchActivity(session.agentId);
    return this.getSettings(sessionId);
  }

  /** Select the session's thinking / reasoning level via the "thought_level" config option. */
  async setThinkingLevel(sessionId: SessionId, level: string): Promise<SessionSettings> {
    const session = this.getSession(sessionId);
    const option = findOptionByCategory(session.configOptions, 'thought_level');
    if (!option) {
      throw new Error(
        `Agent "${session.agentId}" does not advertise a thinking level option for this session ` +
        '(availability can depend on the selected model — see get_session_settings)',
      );
    }
    return this.setConfigOption(sessionId, option.id, level);
  }

  /** Change the MCACP permission policy for an active session and persist it. */
  setPermissionPolicy(sessionId: SessionId, policy: PermissionPolicy): SessionSettings {
    const session = this.getSession(sessionId);
    session.permissionPolicy = policy;
    const file = this.readSessionFile(session.agentId, sessionId);
    if (file) { file.permissionPolicy = policy; this.saveSessionFile(file); }
    return this.getSettings(sessionId);
  }

  /** Apply a session/update notification that changes session settings. */
  applySettingsUpdate(session: ActiveSession, update: SessionUpdate): void {
    if (!('sessionUpdate' in update)) return;
    if (update.sessionUpdate === 'config_option_update') {
      session.configOptions = update.configOptions;
      this.syncFromConfigOptions(session);
    } else if (update.sessionUpdate === 'current_mode_update' && session.modes) {
      // Spec sends currentModeId; older agents send a full modeState.
      const u = update as unknown as { currentModeId?: string; modeState?: SessionModeState };
      const modeId = u.currentModeId ?? u.modeState?.currentModeId;
      if (modeId) session.modes.currentModeId = modeId;
    }
  }

  /** Keep the legacy modes/models views consistent with config option values. */
  private syncFromConfigOptions(session: ActiveSession): void {
    const mode = findOptionByCategory(session.configOptions, 'mode');
    if (mode && session.modes) session.modes.currentModeId = mode.currentValue;
    const model = findOptionByCategory(session.configOptions, 'model');
    if (model && session.models) session.models.currentModelId = model.currentValue;
  }

  listSessions(agentId: string): SessionFile[] {
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9._@/-]/g, '_');
    const sessionsDir = resolve(this.config.sessionDir, safeAgentId, 'sessions');
    if (!existsSync(sessionsDir)) return [];
    const results: SessionFile[] = [];
    try {
      for (const f of readdirSync(sessionsDir).filter(f => f.endsWith('.json'))) {
        try { results.push(JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'))); } catch {}
      }
    } catch {}
    return results;
  }

  closeSession(sessionId: SessionId): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" is not active`);
    const handle = this.lifecycle.getAgent(session.agentId);
    handle.activeSessions.delete(sessionId);
    this.activeSessions.delete(sessionId);
    const file = this.readSessionFile(session.agentId, sessionId);
    if (file) {
      file.closedAt = new Date().toISOString();
      file.lastActiveAt = new Date().toISOString();
      this.saveSessionFile(file);
    }
  }

  getSession(sessionId: SessionId): ActiveSession {
    const session = this.activeSessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" is not active`);
    return session;
  }

  touchSession(sessionId: SessionId): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const file = this.readSessionFile(session.agentId, sessionId);
    if (file) { file.lastActiveAt = new Date().toISOString(); this.saveSessionFile(file); }
    this.lifecycle.touchActivity(session.agentId);
  }

  closeAllForAgent(agentId: string): void {
    for (const [id, session] of this.activeSessions) {
      if (session.agentId === agentId) {
        this.activeSessions.delete(id);
        // Mark session file as closed
        const file = this.readSessionFile(agentId, id);
        if (file) {
          file.closedAt = new Date().toISOString();
          file.lastActiveAt = new Date().toISOString();
          this.saveSessionFile(file);
        }
      }
    }
    // Also clean up on the agent handle
    try {
      const handle = this.lifecycle.getAgent(agentId);
      handle.activeSessions.clear();
    } catch {
      // Agent may already be shut down
    }
  }

  private sessionFilePath(agentId: string, sessionId: SessionId): string {
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9._@/-]/g, '_');
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = resolve(this.config.sessionDir, safeAgentId, 'sessions', `${safeSessionId}.json`);
    const sessionRoot = resolve(this.config.sessionDir);
    if (!filePath.startsWith(sessionRoot + sep)) {
      throw new Error('Invalid agentId or sessionId: path traversal detected');
    }
    return filePath;
  }

  private saveSessionFile(file: SessionFile): void {
    const filePath = this.sessionFilePath(file.agentId, file.sessionId);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(file, null, 2));
  }

  private readSessionFile(agentId: string, sessionId: SessionId): SessionFile | null {
    const path = this.sessionFilePath(agentId, sessionId);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
  }
}
