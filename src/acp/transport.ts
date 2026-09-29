import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { killProcessTree } from './process-tree.js';
import type {
  JsonRpcRequest, JsonRpcResponse, JsonRpcNotification, JsonRpcMessage, JsonRpcError, RequestId,
} from '../types/acp.js';

export interface TransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type IncomingRequestHandler = (method: string, params: unknown, id: RequestId) => Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

export class AcpTransport extends EventEmitter {
  /** Transports with a live agent process, for cleanup when MCACP itself exits. */
  private static live = new Set<AcpTransport>();

  /** Synchronously kill every live agent process tree. Safe to call from a process 'exit' handler. */
  static killAll(): void {
    for (const t of AcpTransport.live) {
      t._closed = true;
      if (t.process) killProcessTree(t.process);
    }
    AcpTransport.live.clear();
  }

  private process: ChildProcess | null = null;
  private pendingRequests = new Map<string | number, PendingRequest>();
  private nextId = 1;
  private requestTimeoutMs: number;
  private onIncomingRequest: IncomingRequestHandler | null = null;
  private onNotification: NotificationHandler | null = null;
  private _closed = false;

  constructor(private options: TransportOptions) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 300_000;
  }

  get closed(): boolean {
    return this._closed;
  }

  lastMessageAt = Date.now();

  start(): void {
    const env = { ...process.env, ...this.options.env };
    this.process = spawn(this.options.command, this.options.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.options.cwd,
      shell: process.platform === 'win32',
      // Own process group on POSIX so the whole tree can be signalled (see killProcessTree).
      // Not on Windows, where detached opens a new console window.
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    AcpTransport.live.add(this);

    this.process.on('exit', (code, signal) => {
      AcpTransport.live.delete(this);
      this._closed = true;
      this.rejectAllPending(new Error(`Agent process exited (code=${code}, signal=${signal})`));
      this.emit('exit', code, signal);
    });

    this.process.on('error', (err) => {
      AcpTransport.live.delete(this);
      this._closed = true;
      this.rejectAllPending(err);
      this.emit('error', err);
    });

    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        this.emit('stderr', chunk.toString());
      });
    }

    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(trimmed);
        } catch (err) {
          this.emit('framingError', trimmed, err);
          return;
        }
        this.lastMessageAt = Date.now();
        if (!this.handleMessage(msg)) {
          this.emit('invalidMessage', msg);
        }
      });
      rl.on('close', () => {
        this._closed = true;
      });
    }
  }

  setRequestHandler(handler: IncomingRequestHandler): void {
    this.onIncomingRequest = handler;
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.onNotification = handler;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this._closed) throw new Error('Transport is closed');
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method} (id=${id})`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.send(msg);
    });
  }

  notify(method: string, params?: unknown): void {
    if (this._closed) throw new Error('Transport is closed');
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(msg);
  }

  /**
   * Close stdin so the agent can exit on its own, then kill the whole process
   * tree if it hasn't exited within killTimeoutMs.
   */
  async close(killTimeoutMs = 5000): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.rejectAllPending(new Error('Transport closing'));

    const proc = this.process;
    if (!proc || proc.exitCode != null || proc.signalCode != null) return;

    proc.stdin?.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), killTimeoutMs);
      proc.once('exit', () => { clearTimeout(timer); resolve(true); });
    });

    if (!exited) {
      killProcessTree(proc);
    } else if (process.platform !== 'win32' && proc.pid != null) {
      // The group leader exited; sweep any members it left behind.
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* group already empty */ }
    }
    AcpTransport.live.delete(this);
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('Cannot write to agent process');
    }
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  private handleMessage(msg: JsonRpcMessage): boolean {
    if ('id' in msg && msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const resp = msg as JsonRpcResponse;
      const idKey = typeof resp.id === 'number' ? resp.id : String(resp.id);
      const pending = this.pendingRequests.get(idKey);
      if (pending) {
        this.pendingRequests.delete(idKey);
        clearTimeout(pending.timer);
        if (resp.error) {
          const err = new Error(resp.error.message);
          (err as any).code = resp.error.code;
          (err as any).data = resp.error.data;
          pending.reject(err);
        } else {
          pending.resolve(resp.result);
        }
      }
      return true;
    }

    if ('id' in msg && 'method' in msg && !('result' in msg) && !('error' in msg)) {
      const req = msg as JsonRpcRequest;
      if (this.onIncomingRequest) {
        this.onIncomingRequest(req.method, req.params, req.id)
          .then((result) => {
            this.send({ jsonrpc: '2.0', id: req.id, result } as JsonRpcResponse);
          })
          .catch((err) => {
            const error: JsonRpcError = {
              code: (err as any).code ?? -32603,
              message: err instanceof Error ? err.message : String(err),
            };
            this.send({ jsonrpc: '2.0', id: req.id, error } as JsonRpcResponse);
          });
      }
      return true;
    }

    if ('method' in msg && !('id' in msg)) {
      const notif = msg as JsonRpcNotification;
      if (this.onNotification) {
        this.onNotification(notif.method, notif.params);
      }
      this.emit('notification', notif.method, notif.params);
      return true;
    }

    return false;
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
