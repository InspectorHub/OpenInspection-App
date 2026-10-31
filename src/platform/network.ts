export interface Network {
  /** Link state only: `true` does not mean the server is reachable. */
  online(): Promise<boolean>;
  /** Returns an unsubscribe function that is safe to call immediately. */
  onChange(cb: (online: boolean) => void): () => void;
}
