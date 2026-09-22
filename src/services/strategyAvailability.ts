import { STRATEGIES_ENABLED } from '../config/releaseFeatures';
import { systemLogService } from './systemLogService';
export function requireStrategiesEnabled(): void {
  if (STRATEGIES_ENABLED) return;
  const message = 'Strategies are locked. Beta access requires a valid key and acceptance in Settings.';
  systemLogService.logError('SYSTEM', 'Strategy action blocked', message);
  throw new Error(message);
}
