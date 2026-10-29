export interface ShutdownDbHost {
  inTransaction(): boolean;
  rollback(): void;
  close(): void;
}

export interface ShutdownState<T extends ShutdownDbHost = ShutdownDbHost> {
  opening: Promise<{ host: T | null }> | null;
  host: T | null;
}

/** Shutdown order is security-sensitive: finish any DB open before rolling back and closing its host. */
export async function shutdownDesktop<T extends ShutdownDbHost>(deps: {
  abortUploads(): void;
  state: ShutdownState<T>;
}): Promise<void> {
  deps.abortUploads();
  const opening = deps.state.opening;
  if (opening) {
    try {
      const result = await opening;
      if (result.host && !deps.state.host) deps.state.host = result.host;
    } catch (error) {
      if (deps.state.opening === opening) deps.state.opening = null;
      throw error;
    }
  }

  const host = deps.state.host;
  if (host) {
    if (host.inTransaction()) host.rollback();
    host.close();
    deps.state.host = null;
  }
  deps.state.opening = null;
}
