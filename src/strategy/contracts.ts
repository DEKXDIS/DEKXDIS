import type { CandlestickData } from 'lightweight-charts';
import type { TokenConfig, TradeOrder } from '../types/trading';

export interface StrategyRun {
  strategyId: string;
  runId: string;
  parameters: Record<string, string>;
  consumedSignals: string[];
}

export interface StrategyContext {
  readonly token: Readonly<TokenConfig>;
  readonly chainId: number;
  readonly now: number;
  readonly candles: readonly Readonly<CandlestickData>[];
  readonly parameters: Readonly<Record<string, string>>;
  readonly consumedSignals: readonly string[];
  /** Only this token/chain's orders, including confirmed executed amounts and exits. */
  readonly orders: readonly Readonly<TradeOrder>[];
}

export interface StrategySignal {
  kind: 'limit-buy';
  /** Stable within a run. Re-emitting the same id never places another order. */
  id: string;
  price: number;
  quoteAmount: string;
  /** The engine creates this exit only after confirmed fill, using actual fill price/quantity. */
  takeProfitPercent?: number;
  stopLossPercent?: number;
}

export interface StrategyDefinition {
  /** Bump this id when replacing rules so saved runs cannot silently use different rules. */
  id: string;
  name: string;
  description: string;
  fields: readonly { key: string; label: string; defaultValue: string; min?: string; step?: string }[];
  marketData: { timeframe: string; candleCount: number };
  validate(parameters: Readonly<Record<string, string>>): void;
  evaluate(context: StrategyContext): readonly StrategySignal[];
}
