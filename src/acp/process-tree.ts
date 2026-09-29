import { spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Forcefully kill a child process and everything it spawned.
 *
 * Agents are rarely a single process: on Windows they are started through a
 * shell (cmd.exe -> powershell -> node), and npx-launched agents fork a node
 * child on every platform. Killing only the direct child orphans the rest.
 *
 * - Windows: `taskkill /T /F` walks the tree by parent PID. It must run while
 *   the root is still alive, since the walk starts from it.
 * - POSIX: the child is spawned `detached`, so it leads its own process group;
 *   signalling the negative PID reaches the whole group.
 *
 * Synchronous so it can be used from a process 'exit' handler.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null || child.exitCode != null || child.signalCode != null) return;

  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      if (result.status === 0) return;
    } catch {
      // taskkill unavailable — fall back to the direct child
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Not a group leader (or already gone) — fall back to the direct child
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already exited */ }
}
