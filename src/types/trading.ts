export interface WalletState {
  address: string;
  isCustom?: boolean;
  needsBackup?: boolean;
}

export interface Balances {
  bnb: string;
  wbnb: string;
  usdt: string;
  totalUsdValue: string;
  isLoading: boolean;
  lastUpdated: number;
  error?: string;
  tokenBalances?: Record<string, string>; // Contract address (lowercase) or symbol -> formatted balance string
}

/** Display-only valuation of the queried wallet assets on one chain. */
export interface WalletValuation {
  ownerAddress: string;
  chainId: number;
  balanceUpdatedAt: number;
  totalUsdValue?: string;
  tokenPricesUsd?: Record<string, number>;
  updatedAt?: number;
  error?: string;
}

export interface AllowanceState {
  wbnbAllowed: boolean;
  usdtAllowed: boolean;
  isChecking: boolean;
  tokenAllowances?: Record<string, boolean>; // Contract address (lowercase) -> boolean
}

export interface TokenConfig {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  chainId: number;
  logoUrl?: string;
  binanceSymbol?: string;
  isCustom?: boolean;
  isAlpha?: boolean;
  alphaId?: string;
}

export const DEFAULT_BSC_TOKENS: TokenConfig[] = [
  {
    symbol: 'WBNB',
    name: 'Wrapped BNB',
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/825/small/bnb-icon2_2x.png',
    binanceSymbol: 'BNBUSDT',
  },
  {
    symbol: 'USDT_BSC',
    name: 'Tether USD (BSC)',
    address: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  },
  {
    symbol: 'BTCB',
    name: 'Bitcoin (Binance-Peg)',
    address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/14108/small/Binance-bitcoin.png',
    binanceSymbol: 'BTCUSDT',
  },
  {
    symbol: 'ETH',
    name: 'Ethereum (Binance-Peg)',
    address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    binanceSymbol: 'ETHUSDT',
  },
  {
    symbol: 'SOL',
    name: 'Solana (Binance-Peg)',
    address: '0x570A5D26f7765Ecb712C0924E4De545B89fD43dF',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/4128/small/solana.png',
    binanceSymbol: 'SOLUSDT',
  },
  {
    symbol: 'DOGE',
    name: 'Dogecoin (Binance-Peg)',
    address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/5/small/dogecoin.png',
    binanceSymbol: 'DOGEUSDT',
  },
  {
    symbol: 'XRP',
    name: 'XRP (Binance-Peg)',
    address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png',
    binanceSymbol: 'XRPUSDT',
  },
  {
    symbol: 'CAKE',
    name: 'PancakeSwap Token',
    address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/12632/small/pancakeswap-cake-logo_crop.png',
    binanceSymbol: 'CAKEUSDT',
  },
  {
    symbol: 'LINK',
    name: 'Chainlink (Binance-Peg)',
    address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/877/small/chainlink-new-logo.png',
    binanceSymbol: 'LINKUSDT',
  },
  {
    symbol: 'ADA',
    name: 'Cardano (Binance-Peg)',
    address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/975/small/cardano.png',
    binanceSymbol: 'ADAUSDT',
  },
  {
    symbol: 'FDUSD',
    name: 'First Digital USD',
    address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/31079/small/First_Digital_USD_Icon.png',
  },
  {
    symbol: 'DAI',
    name: 'Dai Token',
    address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    decimals: 18,
    chainId: 56,
    logoUrl: 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png',
  },
];

export const DEFAULT_ETH_TOKENS: TokenConfig[] = [
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    binanceSymbol: 'ETHUSDT',
  },
  {
    symbol: 'USDT_ETH',
    name: 'Tether USD (Ethereum)',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    decimals: 8,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/14108/small/Binance-bitcoin.png',
    binanceSymbol: 'BTCUSDT',
  },
  {
    symbol: 'UNI',
    name: 'Uniswap',
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/12504/small/uniswap-uni.png',
    binanceSymbol: 'UNIUSDT',
  },
  {
    symbol: 'LINK',
    name: 'Chainlink',
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/877/small/chainlink-new-logo.png',
    binanceSymbol: 'LINKUSDT',
  },
  {
    symbol: 'SHIB',
    name: 'Shiba Inu',
    address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/11939/small/shiba.png',
    binanceSymbol: 'SHIBUSDT',
  },
  {
    symbol: 'PEPE',
    name: 'Pepe',
    address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/29850/small/pepe-token.png',
    binanceSymbol: 'PEPEUSDT',
  },
  {
    symbol: 'AAVE',
    name: 'Aave',
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/12645/small/AAVE.png',
    binanceSymbol: 'AAVEUSDT',
  },
  {
    symbol: 'COW',
    name: 'CoW Protocol',
    address: '0xDEf1CA1fb7FBcDC777520aa7f396b4E015F497aB',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/24564/small/cow.png',
    binanceSymbol: 'COWUSDT',
  },
  {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    chainId: 1,
    logoUrl: 'https://assets.coingecko.com/coins/images/9956/small/Badge_Dai.png',
  },
];

export const DEFAULT_ARB_TOKENS: TokenConfig[] = [
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    binanceSymbol: 'ETHUSDT',
  },
  {
    symbol: 'USDT_ARB',
    name: 'Tether USD (Arbitrum)',
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    decimals: 6,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  },
  {
    symbol: 'ARB',
    name: 'Arbitrum',
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/16547/small/arbitrum_logo.png',
    binanceSymbol: 'ARBUSDT',
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    decimals: 8,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/14108/small/Binance-bitcoin.png',
    binanceSymbol: 'BTCUSDT',
  },
  {
    symbol: 'GMX',
    name: 'GMX',
    address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/18323/small/arbit.png',
    binanceSymbol: 'GMXUSDT',
  },
  {
    symbol: 'PENDLE',
    name: 'Pendle',
    address: '0x0c880f670413da545147846f86cc52ac3073099e',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/15069/small/pendle.png',
    binanceSymbol: 'PENDLEUSDT',
  },
  {
    symbol: 'LINK',
    name: 'Chainlink',
    address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/877/small/chainlink-new-logo.png',
    binanceSymbol: 'LINKUSDT',
  },
  {
    symbol: 'UNI',
    name: 'Uniswap',
    address: '0xFa7F8980b0f1E64A2062791ce3b087c9D3fe9782',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/12504/small/uniswap-uni.png',
    binanceSymbol: 'UNIUSDT',
  },
  {
    symbol: 'MAGIC',
    name: 'Magic',
    address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/18623/small/magic.png',
    binanceSymbol: 'MAGICUSDT',
  },
  {
    symbol: 'COW',
    name: 'CoW Protocol',
    address: '0xcB8b5CD20bbeC543158876F80dd5dd95B720411F',
    decimals: 18,
    chainId: 42161,
    logoUrl: 'https://assets.coingecko.com/coins/images/24564/small/cow.png',
    binanceSymbol: 'COWUSDT',
  },
];

export const DEFAULT_BASE_TOKENS: TokenConfig[] = [
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    binanceSymbol: 'ETHUSDT',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  },
  {
    symbol: 'USDT_BASE',
    name: 'Tether USD (Base)',
    address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
    decimals: 6,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    decimals: 8,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/14108/small/Binance-bitcoin.png',
    binanceSymbol: 'BTCUSDT',
  },
  {
    symbol: 'AERO',
    name: 'Aerodrome Finance',
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/31745/small/aerodrome.png',
    binanceSymbol: 'AEROUSDT',
  },
  {
    symbol: 'BRETT',
    name: 'Brett',
    address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/35529/small/brett.png',
  },
  {
    symbol: 'VIRTUAL',
    name: 'Virtual Protocol',
    address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/33898/small/virtual.png',
  },
  {
    symbol: 'DEGEN',
    name: 'Degen',
    address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/34515/small/degen.png',
  },
  {
    symbol: 'TOSHI',
    name: 'Toshi',
    address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/31201/small/toshi.png',
  },
  {
    symbol: 'COW',
    name: 'CoW Protocol',
    address: '0x53C89cd4f18d5cb684F66C2c040d65215cE016aE',
    decimals: 18,
    chainId: 8453,
    logoUrl: 'https://assets.coingecko.com/coins/images/24564/small/cow.png',
    binanceSymbol: 'COWUSDT',
  },
];

export const DEFAULT_GNO_TOKENS: TokenConfig[] = [
  {
    symbol: 'WXDAI',
    name: 'Wrapped xDAI',
    address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
    decimals: 18,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/11062/small/xdai.png',
  },
  {
    symbol: 'GNO',
    name: 'Gnosis',
    address: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
    decimals: 18,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/662/small/gnosis_logo.png',
    binanceSymbol: 'GNOUSDT',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0xddafbb505ad214d7b80b1f830fccc89b60fb7a83',
    decimals: 6,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png',
  },
  {
    symbol: 'USDT_GNO',
    name: 'Tether USD (Gnosis)',
    address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6',
    decimals: 6,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/325/small/Tether.png',
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0x6A023CCD1ff6F2045C3309768eAd9E68453d433B',
    decimals: 18,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png',
    binanceSymbol: 'ETHUSDT',
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    address: '0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252',
    decimals: 8,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/14108/small/Binance-bitcoin.png',
    binanceSymbol: 'BTCUSDT',
  },
  {
    symbol: 'COW',
    name: 'CoW Protocol',
    address: '0x177127b9dD673D2F929225Da0609822a7B6ce7C8',
    decimals: 18,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/24564/small/cow.png',
    binanceSymbol: 'COWUSDT',
  },
  {
    symbol: 'BAL',
    name: 'Balancer',
    address: '0x7eF541E2a22058048904fE5744f9c7E4C57AF717',
    decimals: 18,
    chainId: 100,
    logoUrl: 'https://assets.coingecko.com/coins/images/11683/small/Balancer.png',
    binanceSymbol: 'BALUSDT',
  },
];

export function getDefaultTokensForChain(chainId: number): TokenConfig[] {
  switch (chainId) {
    case 1:
      return DEFAULT_ETH_TOKENS;
    case 42161:
      return DEFAULT_ARB_TOKENS;
    case 8453:
      return DEFAULT_BASE_TOKENS;
    case 100:
      return DEFAULT_GNO_TOKENS;
    case 56:
    default:
      return DEFAULT_BSC_TOKENS;
  }
}

export type StrategyType = 
  | 'zscore_channel'
  | 'zigzag_sr'
  | 'donchian_midpoint'
  | 'extrema_binning'
  | 'support_bounce'
  | 'donchian_breakout'
  | 'ema_cross' 
  | 'rsi_reversion' 
  | 'macd_cross' 
  | 'confluence';

export interface StrategyConfig {
  id: string;
  name: string;
  type: StrategyType;
  baseToken: TokenConfig;
  quoteToken: TokenConfig;
  timeframe: string; // '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
  orderSizeUsd: number;
  
  // Indicator Parameters
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  donchianPeriod: number;
  donchianReboundTolerancePct?: number;
  zigzagDeviationPct: number;
  zigzagDepth: number;
  zigzagTolerancePct?: number;
  extremaWindow: number;
  extremaBinCount: number;
  extremaClusterTolerancePct?: number;
  extremaMinTouches?: number;
  macdFastPeriod?: number;
  macdSlowPeriod?: number;
  macdSignalPeriod?: number;

  // Z-Score Asymmetric Channel Parameters
  zscorePeriod?: number;
  zscoreUpperMult?: number;
  zscoreLowerMult?: number;
  zscoreCandleMeasure?: 'range' | 'body';
  zscoreMinCandleZ?: number;
  zscoreMaxCandleZ?: number;
  zscoreExhaustionPct?: number;
  zscoreTradeSide?: 'both' | 'buy_only' | 'sell_only';
  
  // Execution & Risk Parameters
  enableTp?: boolean;
  enableSl?: boolean;
  tpPercent: number;
  slPercent: number;
  autoBracket?: boolean;
  cooldownCandles: number;
  
  // Runtime State
  isActive: boolean;
  lastTriggerCandleTime?: number;
  lastTriggerPrice?: number;
  lastTriggerReason?: string;
}

export interface CowQuoteRequest {
  sellToken: string;
  buyToken: string;
  sellAmountBeforeFee?: string;
  buyAmountAfterFee?: string;
  kind: 'sell' | 'buy';
  from: string;
  receiver?: string;
  validTo?: number;
  appData?: string;
  appDataHash?: string;
  partiallyFillable?: boolean;
}

export interface CowQuoteResponse {
  quote: {
    sellToken: string;
    buyToken: string;
    receiver: string | null;
    sellAmount: string;
    buyAmount: string;
    validTo: number;
    appData: string;
    appDataHash?: string;
    feeAmount: string;
    kind: 'sell' | 'buy';
    partiallyFillable: boolean;
    sellTokenBalance: string;
    buyTokenBalance: string;
    signingScheme: string;
  };
  from: string;
  expiration: string;
  id: number;
  verified: boolean;
  protocolFeeBps?: string;
}

export type OrderStatus = 'pending' | 'open' | 'fulfilled' | 'cancelled' | 'expired';

export interface TradeBracketConfig {
  takeProfitValidity?: 'maximum';
  // Opt-in only: existing/manual brackets retain their explicitly chosen prices.
  priceBasis?: 'actual-fill';
  tpEnabled: boolean;
  tpPercent: number;
  tpPrice: number;
  slEnabled: boolean;
  slPercent: number;
  slPrice: number;
  parentOrderId?: string;
  ocoGroupId?: string;
  tpOrderId?: string;
  slOrderId?: string;
  isTriggered?: boolean;
  isCompleted?: boolean;
}

export interface TradeOrder {
  automationRequestId?: string;
  id: string; // Order UID from CoW Protocol
  ownerAddress?: string;
  submissionError?: string;
  cancelTxHash?: string;
  protectionError?: string;
  parentOrderId?: string;
  signalKey?: string;
  txHash?: string;
  timestamp: number;
  type: 'BNB_TO_USDT' | 'USDT_TO_BNB' | 'TOKEN_SWAP';
  orderCategory?: 'market' | 'limit' | 'limit_sell' | 'take_profit' | 'stop_loss' | 'strategy_buy' | 'strategy_sell';
  strategyId?: string;

  ocoGroupId?: string;
  connectedOrderId?: string;
  limitPrice?: number;
  triggerPrice?: number;
  isConditional?: boolean;
  bracket?: TradeBracketConfig;
  fillTimestamp?: number;
  settlementTimestamp?: number; // Verified settlement block time in milliseconds.
  candleTime?: number;
  sellToken: string;
  buyToken: string;
  sellSymbol: string;
  buySymbol: string;
  sellAmount: string;
  buyAmount: string;
  /** USD per base token, never raw quote-token units. */
  executionPrice: number;
  tradeSide?: 'buy' | 'sell';
  quoteTokenAddress?: string;
  /** USD conversion recorded when constructing the token amounts. */
  quoteUsdPrice?: number;
  /** USD conversion observed when the fill is reconciled (not a settlement oracle). */
  executedQuoteUsdPrice?: number;
  executedQuotePriceTimestamp?: number;
  status: OrderStatus;
  feeAmount: string;
  validTo: number;
  explorerUrl: string;
  executedSellAmount?: string;
  executedBuyAmount?: string;
  sellDecimals?: number;
  buyDecimals?: number;
  chainId?: number;
  isExternal?: boolean;
  externalOrderId?: string;
  triggerTimestamp?: number;
  retryCount?: number;
  previousOrderId?: string;
}

export interface LimitOrderSettings {
  defaultUsdAmount: string;
  tpEnabled: boolean;
  tpPercent: number;
  slEnabled: boolean;
  slPercent: number;
}

export interface ChartMarker {
  id: string;
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  color: string;
  shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
  text: string;
  size?: number;
  orderId?: string;
  isStrategySignal?: boolean;
  signalReason?: string;
  tokenAddress?: string;
  chainId?: number;
}

export interface TradingMetrics {
  totalTrades: number;
  totalBuys: number;
  totalSells: number;
  totalVolumeUsdt: number;
  totalVolumeBnb: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  realizedPnlUsdt: number;
}

export interface MarketPrice {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  lastUpdated: number;
  symbol?: string;
}

export interface SimulatedTrade {
  id: string;
  strategyId: string;
  strategyType: StrategyType;
  entryTime: number;
  entryPrice: number;
  exitTime?: number;
  exitPrice?: number;
  status: 'open' | 'closed';
  pnlUsd: number;
  pnlPercent: number;
  exitReason?: string;
  entryReason: string;
  usdAmount: number;
  tokenAmount: number;
  tpPrice: number;
  slPrice: number;
}

export interface SimulationResult {
  trades: SimulatedTrade[];
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  profitFactor: number;
  avgPnlUsd: number;
  configuredUsdAmount: number;
  startDate?: number;
  endDate?: number;
  candleCount: number;
}

export interface ChartUserSettings {
  showVolume: boolean;
  showEMA: boolean;
  showRSI: boolean;
  showMACD: boolean;
  showDonchian: boolean;
  showZigZag: boolean;
  showSR: boolean;
  showSignals: boolean;
  showZScore?: boolean;
  interval: string;
  logicalRange?: { from: number; to: number } | null;
}
