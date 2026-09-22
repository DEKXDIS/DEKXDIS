import { TokenConfig, getDefaultTokensForChain } from './trading';
export { getDefaultTokensForChain } from './trading';

export interface ChainConfig {
  chainId: number;
  name: string;
  shortName: string;
  networkId: string; // GeckoTerminal network identifier
  rpcUrls: string[];
  nativeToken: {
    symbol: string;
    name: string;
    decimals: number;
    wrappedAddress: string;
    wrappedSymbol: string;
  };
  usdtToken: {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
  };
  cowApiBase: string;
  cowSettlement: string;
  cowVaultRelayer: string;
  explorerUrl: string;
  explorerName: string;
  txUrl: (hash: string) => string;
  addressUrl: (address: string) => string;
}

export const COW_SETTLEMENT_ADDRESS = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
export const COW_VAULT_RELAYER_ADDRESS = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  56: {
    chainId: 56,
    name: 'BNB Smart Chain',
    shortName: 'BSC',
    networkId: 'bsc',
    rpcUrls: [
      'https://bsc-dataseed.bnbchain.org',
      'https://bsc-dataseed1.defibit.io',
      'https://bsc-dataseed1.ninicoin.io',
      'https://bsc-dataseed2.defibit.io',
      'https://bsc-dataseed3.defibit.io',
      'https://bsc-rpc.publicnode.com',
    ],
    nativeToken: {
      symbol: 'BNB',
      name: 'BNB',
      decimals: 18,
      wrappedAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      wrappedSymbol: 'WBNB',
    },
    usdtToken: {
      symbol: 'USDT_BSC',
      name: 'Tether USD (BSC)',
      address: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
    },
    cowApiBase: 'https://api.cow.fi/bnb/api/v1',
    cowSettlement: COW_SETTLEMENT_ADDRESS,
    cowVaultRelayer: COW_VAULT_RELAYER_ADDRESS,
    explorerUrl: 'https://bscscan.com',
    explorerName: 'BscScan',
    txUrl: (hash: string) => `https://bscscan.com/tx/${hash}`,
    addressUrl: (address: string) => `https://bscscan.com/address/${address}`,
  },
  1: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    shortName: 'ETH',
    networkId: 'eth',
    rpcUrls: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.llamarpc.com',
      'https://rpc.mevblocker.io',
    ],
    nativeToken: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      wrappedAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      wrappedSymbol: 'WETH',
    },
    usdtToken: {
      symbol: 'USDT_ETH',
      name: 'Tether USD (Ethereum)',
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      decimals: 6,
    },
    cowApiBase: 'https://api.cow.fi/mainnet/api/v1',
    cowSettlement: COW_SETTLEMENT_ADDRESS,
    cowVaultRelayer: COW_VAULT_RELAYER_ADDRESS,
    explorerUrl: 'https://etherscan.io',
    explorerName: 'Etherscan',
    txUrl: (hash: string) => `https://etherscan.io/tx/${hash}`,
    addressUrl: (address: string) => `https://etherscan.io/address/${address}`,
  },
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    shortName: 'ARB',
    networkId: 'arbitrum',
    rpcUrls: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.llamarpc.com',
    ],
    nativeToken: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      wrappedAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      wrappedSymbol: 'WETH',
    },
    usdtToken: {
      symbol: 'USDT_ARB',
      name: 'Tether USD (Arbitrum)',
      address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      decimals: 6,
    },
    cowApiBase: 'https://api.cow.fi/arbitrum_one/api/v1',
    cowSettlement: COW_SETTLEMENT_ADDRESS,
    cowVaultRelayer: COW_VAULT_RELAYER_ADDRESS,
    explorerUrl: 'https://arbiscan.io',
    explorerName: 'Arbiscan',
    txUrl: (hash: string) => `https://arbiscan.io/tx/${hash}`,
    addressUrl: (address: string) => `https://arbiscan.io/address/${address}`,
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    shortName: 'BASE',
    networkId: 'base',
    rpcUrls: [
      'https://mainnet.base.org',
      'https://developer-access-mainnet.base.org',
      'https://base-rpc.publicnode.com',
      'https://base.llamarpc.com',
    ],
    nativeToken: {
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      wrappedAddress: '0x4200000000000000000000000000000000000006',
      wrappedSymbol: 'WETH',
    },
    usdtToken: {
      symbol: 'USDT_BASE',
      name: 'Tether USD (Base)',
      address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      decimals: 6,
    },
    cowApiBase: 'https://api.cow.fi/base/api/v1',
    cowSettlement: COW_SETTLEMENT_ADDRESS,
    cowVaultRelayer: COW_VAULT_RELAYER_ADDRESS,
    explorerUrl: 'https://basescan.org',
    explorerName: 'BaseScan',
    txUrl: (hash: string) => `https://basescan.org/tx/${hash}`,
    addressUrl: (address: string) => `https://basescan.org/address/${address}`,
  },
  100: {
    chainId: 100,
    name: 'Gnosis Chain',
    shortName: 'GNO',
    networkId: 'xdai',
    rpcUrls: [
      'https://rpc.gnosischain.com',
      'https://gnosis-rpc.publicnode.com',
      'https://gnosis.api.onfinality.io/public',
    ],
    nativeToken: {
      symbol: 'xDAI',
      name: 'xDAI',
      decimals: 18,
      wrappedAddress: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
      wrappedSymbol: 'WXDAI',
    },
    usdtToken: {
      symbol: 'USDT_GNO',
      name: 'Tether USD (Gnosis)',
      address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6',
      decimals: 6,
    },
    cowApiBase: 'https://api.cow.fi/xdai/api/v1',
    cowSettlement: COW_SETTLEMENT_ADDRESS,
    cowVaultRelayer: COW_VAULT_RELAYER_ADDRESS,
    explorerUrl: 'https://gnosisscan.io',
    explorerName: 'Gnosisscan',
    txUrl: (hash: string) => `https://gnosisscan.io/tx/${hash}`,
    addressUrl: (address: string) => `https://gnosisscan.io/address/${address}`,
  },
};

export const DEFAULT_CHAIN_ID = 56;

export function getChainConfig(chainId: number = DEFAULT_CHAIN_ID): ChainConfig {
  const config = SUPPORTED_CHAINS[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported chains are: ${Object.keys(SUPPORTED_CHAINS).join(', ')}`);
  }
  return config;
}

export function getTokensForChain(chainId: number = DEFAULT_CHAIN_ID): TokenConfig[] {
  return getDefaultTokensForChain(chainId);
}

/** Settlement asset for ordinary chain trading; USD is only the input/display unit. */
export function getTradingQuoteToken(chainId: number): TokenConfig {
  const native = getChainConfig(chainId).nativeToken;
  return { chainId, address: native.wrappedAddress, symbol: native.wrappedSymbol,
    name: native.wrappedSymbol, decimals: native.decimals };
}
