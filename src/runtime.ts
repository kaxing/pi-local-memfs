import type { MemfsConfig } from "./config.js";
import type { GitMemoryStore } from "./git-store.js";

export interface RuntimeState {
  enabled: boolean;
  agent: string;
  config: MemfsConfig | undefined;
  store: GitMemoryStore | undefined;
}

export function requireEnabledStore(state: RuntimeState): GitMemoryStore {
  if (!state.enabled || !state.store) {
    throw new Error("local-memfs is disabled; run /local-memfs on");
  }
  return state.store;
}
