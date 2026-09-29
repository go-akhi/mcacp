import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

const { AcpTransport } = await import('../src/acp/transport.js');
const { killProcessTree } = await import('../src/acp/process-tree.js');

function createMockProcess(pid = 4242) {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(proc, {
    stdout: new Readable({ read() {} }),
    stderr: new Readable({ read() {} }),
    stdin: new Writable({ write(_c, _e, cb) { cb(); } }),
    killed: false,
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  });
  return proc;
}

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('process tree cleanup', () => {
  const realPlatform = process.platform;
  let proc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    proc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(proc as any);
    vi.mocked(spawnSync).mockClear();
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
  });

  describe('killProcessTree', () => {
    it('uses taskkill /T /F on Windows', () => {
      setPlatform('win32');
      killProcessTree(proc);
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], expect.anything());
      expect(proc.kill).not.toHaveBeenCalled();
    });

    it('falls back to killing the child if taskkill fails', () => {
      setPlatform('win32');
      vi.mocked(spawnSync).mockReturnValueOnce({ status: 128 } as any);
      killProcessTree(proc);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('signals the process group on POSIX', () => {
      setPlatform('linux');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      killProcessTree(proc);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(proc.kill).not.toHaveBeenCalled();
    });

    it('falls back to the child when the group signal fails on POSIX', () => {
      setPlatform('linux');
      vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('ESRCH'); });
      killProcessTree(proc);
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('does nothing for an already-exited process', () => {
      setPlatform('win32');
      Object.assign(proc, { exitCode: 0 });
      killProcessTree(proc);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(proc.kill).not.toHaveBeenCalled();
    });
  });

  describe('AcpTransport.close', () => {
    it('spawns detached on POSIX only', () => {
      setPlatform('linux');
      new AcpTransport({ command: 'agent' }).start();
      expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({ detached: true, shell: false });

      setPlatform('win32');
      new AcpTransport({ command: 'agent' }).start();
      expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]).toMatchObject({ detached: false, shell: true });
    });

    it('kills the whole tree when the agent ignores stdin EOF', async () => {
      setPlatform('win32');
      const t = new AcpTransport({ command: 'agent' });
      t.start();
      await t.close(20);
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], expect.anything());
    });

    it('does not force-kill an agent that exits on stdin EOF', async () => {
      setPlatform('win32');
      const t = new AcpTransport({ command: 'agent' });
      t.start();
      proc.stdin!.on('finish', () => {
        Object.assign(proc, { exitCode: 0 });
        proc.emit('exit', 0, null);
      });
      await t.close(1000);
      expect(spawnSync).not.toHaveBeenCalled();
    });

    it('sweeps leftover group members after a graceful exit on POSIX', async () => {
      setPlatform('linux');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const t = new AcpTransport({ command: 'agent' });
      t.start();
      proc.stdin!.on('finish', () => {
        Object.assign(proc, { exitCode: 0 });
        proc.emit('exit', 0, null);
      });
      await t.close(1000);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    });
  });

  describe('AcpTransport.killAll', () => {
    it('kills every live agent tree and skips exited ones', () => {
      setPlatform('win32');
      const a = createMockProcess(1001);
      const b = createMockProcess(1002);
      vi.mocked(spawn).mockReturnValueOnce(a as any).mockReturnValueOnce(b as any);
      const ta = new AcpTransport({ command: 'a' });
      const tb = new AcpTransport({ command: 'b' });
      ta.start();
      tb.start();
      Object.assign(b, { exitCode: 1 });
      b.emit('exit', 1, null);

      AcpTransport.killAll();

      const pids = vi.mocked(spawnSync).mock.calls.map(c => (c[1] as string[])[1]);
      expect(pids).toContain('1001');
      expect(pids).not.toContain('1002');
      expect(ta.closed).toBe(true);
    });
  });
});
