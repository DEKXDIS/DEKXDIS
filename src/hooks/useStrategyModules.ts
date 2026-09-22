import { useSyncExternalStore } from 'react';
import { moduleRegistry } from '../modules/registry';
import { moduleStateStore } from '../modules/stateStore';
export function useStrategyModules() {
  const registry = useSyncExternalStore(moduleRegistry.subscribe, moduleRegistry.getSnapshot, moduleRegistry.getSnapshot);
  const runs = useSyncExternalStore(moduleStateStore.subscribe, moduleStateStore.getSnapshot, moduleStateStore.getSnapshot);
  return { ...registry, runs };
}
