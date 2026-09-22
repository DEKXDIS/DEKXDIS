import features from './releaseFeatures.json';
import { invoke, isTauri } from '@tauri-apps/api/core';
import terms from './betaTerms.json';
export let STRATEGIES_ENABLED = features.strategies;
const listeners = new Set<() => void>();
export const subscribeReleaseFeatures = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getStrategiesEnabled = () => STRATEGIES_ENABLED;
function publish(enabled: boolean) { STRATEGIES_ENABLED = features.strategies || enabled; listeners.forEach(listener => listener()); }
export async function initializeReleaseFeatures(): Promise<void> {
  if (isTauri()) publish(await invoke<boolean>('beta_status'));
}
export async function validateBetaKey(key: string): Promise<void> {
  if (!isTauri()) throw new Error('Beta access is available in the desktop application.');
  await invoke('beta_validate_key', { key });
}
export async function acceptBeta(key: string, agreed: boolean): Promise<void> {
  if (!isTauri()) throw new Error('Beta access is available in the desktop application.');
  if (!agreed) throw new Error('You must accept the beta testing agreement.');
  const enabled = await invoke<boolean>('beta_accept', { key, agreed, termsVersion: terms.version });
  if (!enabled) throw new Error('Beta access was not enabled.');
  publish(true);
}
