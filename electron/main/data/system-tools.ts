import { win32 } from 'node:path';
import type { LogEvent } from '../logger.ts';
import type { SecurityCommand } from './windows-security.ts';

/** Path of each launchable Windows tool below the System32 directory. Anything not listed here is never launched. */
const TOOLS: Readonly<Record<string, readonly string[]>> = {
  'whoami.exe': ['whoami.exe'],
  'icacls.exe': ['icacls.exe'],
  'fsutil.exe': ['fsutil.exe'],
  'powershell.exe': ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
};

class SystemToolError extends Error {
  readonly code = 'system-tool-unresolved';
  constructor() {
    super('system-tool-unresolved');
    this.name = 'SystemToolError';
  }
}

type ExecDone = (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void;

/**
 * Runs the Windows tools of the security module from `%SystemRoot%\System32` and nowhere else. A bare command name
 * would be looked up through PATH, where another tool of the same name (for example a GNU `whoami` installed with Git)
 * could answer instead. When the tool cannot be resolved to an existing file the call fails closed: it is logged
 * and rejected, and PATH is never consulted.
 */
export function createSystemCommandRunner(deps: {
  execFile: (file: string, args: string[], options: { windowsHide: boolean; encoding: 'utf8' }, done: ExecDone) => void;
  env: { SystemRoot?: string | undefined };
  exists: (path: string) => boolean;
  log: (event: LogEvent) => void;
}): SecurityCommand {
  const resolve = (tool: string): string => {
    const segments = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined;
    const systemRoot = deps.env.SystemRoot;
    if (!segments || !systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot) || systemRoot.split(/[\\/]/).includes('..')) throw new SystemToolError();
    const file = win32.join(systemRoot, 'System32', ...segments);
    if (!deps.exists(file)) throw new SystemToolError();
    return file;
  };
  return async (command, args) => {
    let file: string;
    try {
      file = resolve(command);
    } catch (error) {
      deps.log('system-tool-unresolved');
      throw error;
    }
    // Asynchronous so that a cold powershell start does not block the main process's event loop during startup.
    return new Promise((done) => {
      deps.execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        done({ status: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr });
      });
    });
  };
}
