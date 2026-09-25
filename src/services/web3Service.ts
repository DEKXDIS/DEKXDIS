import { confirmedTransaction } from './transactionJournal';
import { estimateTransferGas, gasTransactionFields } from './transferGas';
import { storageService } from './storageService';
import { NativeSigner } from './nativeSigner';
import { nativeStore } from './nativeStore';
import { ethers } from 'ethers';
import { Balances, AllowanceState, WalletState, TokenConfig } from '../types/trading';
import { 
  getChainConfig, 
  DEFAULT_CHAIN_ID, 
  COW_VAULT_RELAYER_ADDRESS, 
  COW_SETTLEMENT_ADDRESS, 
  SUPPORTED_CHAINS, 
  ChainConfig, 
  getDefaultTokensForChain,
  MULTICALL3_ADDRESS
} from '../types/chains';
import { marketDataService } from './marketDataService';
import { systemLogService } from './systemLogService';
import { formatTokenDisplay } from '../utils/displayFormat';

import { rpcService } from './rpcService';

export const BSC_CHAIN_ID = 56;
export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
export const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
export const COW_VAULT_RELAYER = COW_VAULT_RELAYER_ADDRESS;
export const COW_SETTLEMENT = COW_SETTLEMENT_ADDRESS;

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const WRAPPED_NATIVE_ABI = [
  ...ERC20_ABI,
  'function deposit() public payable',
  'function withdraw(uint256 wad) public',
];

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
];

const ERC20_INTERFACE = new ethers.Interface(ERC20_ABI);
const MULTICALL3_INTERFACE = new ethers.Interface(MULTICALL3_ABI);

function balanceReadFailure(chainId: number, cause: unknown): Error & { code: string } {
  if (cause instanceof Error && 'code' in cause && cause.code === 'BALANCE_READ_FAILED') return cause as Error & { code: string };
  return Object.assign(new Error(`[BALANCE_READ_FAILED] Unable to read ${getChainConfig(chainId).shortName} balances. Retry the balance query.`),
    { code: 'BALANCE_READ_FAILED', cause });
}

export interface ChainTokenBalance {
  token: TokenConfig;
  balance: string;
  usdValue: number | null;
  priceUsd: number | null;
}

export interface ChainBalanceReport {
  chainId: number;
  chainConfig: any;
  nativeBalance: string | null;
  nativeUsd: number | null;
  wrappedBalance: string | null;
  wrappedUsd: number | null;
  usdtBalance: string | null;
  usdtUsd: number | null;
  usdcBalance: string | null;
  usdcUsd: number | null;
  tokens: ChainTokenBalance[];
  totalChainUsd: number | null;
  knownTotalChainUsd: number | null;
  nativePriceUsd: number | null;
  isLoading: boolean;
  error?: string;
}

export interface ChainGasFeeInfo {
  chainId: number;
  chainName: string;
  shortName: string;
  gasPriceGwei: number;
  baseFeeGwei?: number;
  estimatedApprovalUsd: number;
  estimatedWrapUsd: number;
  nativePriceUsd: number;
  lastUpdated: number;
}

export const web3Service = {
  /** Execution reads the requested token directly; portfolio/allowance failures are not zero funds. */
  async getTokenBalanceWei(walletAddress: string, tokenAddress: string, chainId: number): Promise<bigint> {
    if (!ethers.isAddress(walletAddress) || !ethers.isAddress(tokenAddress)) throw new Error('Invalid balance query address');
    try {
      return await this.executeWithRpcFallback(chainId, async provider => {
        if (Number((await provider.getNetwork()).chainId) !== chainId) throw new Error('Balance RPC chain mismatch');
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        return BigInt(await contract.balanceOf(walletAddress));
      });
    } catch (error) {
      throw balanceReadFailure(chainId, error);
    }
  },
  async ensureAllowance(walletAddress: string, tokenAddress: string, amount: bigint, chainId: number, allowAutoWrap = false) {
    const chain = getChainConfig(chainId);
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.getSigner(walletAddress, chainId));
    const [balanceValue, allowanceValue] = await Promise.all([
      contract.balanceOf(walletAddress), contract.allowance(walletAddress, chain.cowVaultRelayer),
    ]);
    let balance = BigInt(balanceValue);
    if (balance < amount && allowAutoWrap && storageService.getAutoWrap() && tokenAddress.toLowerCase() === chain.nativeToken.wrappedAddress.toLowerCase()) {
      await this.wrapNative(walletAddress, ethers.formatUnits(amount - balance, chain.nativeToken.decimals), chainId);
      balance = BigInt(await contract.balanceOf(walletAddress));
    }
    if (balance < amount) throw new Error('Insufficient token balance for this order');
    const allowance = BigInt(allowanceValue);
    if (allowance >= amount) return;
    // Shared relayer allowance with zero-reset support and durable transaction recovery.
    const signer = this.getSigner(walletAddress, chainId);
    if (allowance > 0n) await confirmedTransaction(signer, chainId, tokenAddress, contract.interface.encodeFunctionData('approve', [chain.cowVaultRelayer, 0n]));
    await confirmedTransaction(signer, chainId, tokenAddress, contract.interface.encodeFunctionData('approve', [chain.cowVaultRelayer, ethers.MaxUint256]));
  },
  getProvider(chainId: number = DEFAULT_CHAIN_ID, rpcIndex: number = 0): ethers.JsonRpcProvider {
    const rpcList = rpcService.getRpcUrls(chainId);
    const url = rpcList[rpcIndex] || rpcList[0];
    const request = new ethers.FetchRequest(url); request.timeout = 12000;
    return new ethers.JsonRpcProvider(request);
  },

  async executeWithRpcFallback<T>(
    chainId: number,
    operation: (provider: ethers.JsonRpcProvider) => Promise<T>
  ): Promise<T> {
    const chainConfig = getChainConfig(chainId);
    const rpcList = rpcService.getRpcUrls(chainId);
    let lastError: any = null;

    for (let i = 0; i < rpcList.length; i++) {
      const endpoint = rpcList[i];
      try {
        const request = new ethers.FetchRequest(endpoint); request.timeout = 12000;
        const provider = new ethers.JsonRpcProvider(request);
        try { return await operation(provider); } finally { provider.destroy(); }
      } catch (err: any) {
        lastError = err;
        rpcService.markRpcFailed(chainId, endpoint);
        systemLogService.logWarning(
          'RPC',
          `RPC Fallback Triggered (${chainConfig.shortName})`,
          `Endpoint ${new URL(endpoint).hostname} unavailable. Trying the next node.`,
          chainId
        );
      }
    }
    const finalErr = lastError || new Error(`All RPC endpoints failed for chain ${chainId} (${chainConfig.name})`);
    systemLogService.logError(
      'RPC',
      `All RPC Endpoints Failed (${chainConfig.shortName})`,
      finalErr?.message || String(finalErr),
      chainId
    );
    throw finalErr;
  },

  async executeWithSignerFallback<T>(
    walletAddress: string,
    chainId: number,
    operation: (signer: NativeSigner, provider: ethers.JsonRpcProvider) => Promise<T>
  ): Promise<T> {
    // Only provider preflight can fail over. Never repeat an operation after signing/broadcast.
    let selected: ethers.JsonRpcProvider | undefined;
    for (const endpoint of rpcService.getRpcUrls(chainId)) {
      const request = new ethers.FetchRequest(endpoint); request.timeout = 12000;
      const provider = new ethers.JsonRpcProvider(request);
      try {
        if (Number((await provider.getNetwork()).chainId) !== chainId) throw new Error('RPC chain mismatch');
        selected = provider; break;
      } catch { provider.destroy(); rpcService.markRpcFailed(chainId, endpoint); }
    }
    if (!selected) throw new Error('No responding RPC on the selected chain. Try again when the network is available.');
    try { return await operation(new NativeSigner(walletAddress, selected, chainId), selected); }
    finally { selected.destroy(); }
  },

  getSigner(walletAddress: string, chainId: number = DEFAULT_CHAIN_ID): NativeSigner {
    const provider = this.getProvider(chainId);
    return new NativeSigner(walletAddress, provider, chainId);
  },

  generateNewWallet(): Promise<WalletState> { return nativeStore.replaceWallet(); },
  importWallet(input: string): Promise<WalletState> { return nativeStore.replaceWallet(input); },

  async getBalancesAndAllowancesBatched(
    address: string,
    chainId: number = DEFAULT_CHAIN_ID,
    tokens: TokenConfig[] = []
  ): Promise<{
    nativeBalance: string;
    tokenBalances: Record<string, string>;
    tokenAllowances: Record<string, boolean>;
  }> {
    const chainConfig = getChainConfig(chainId);
    const wrappedAddress = chainConfig.nativeToken.wrappedAddress.toLowerCase();
    const usdtAddress = chainConfig.usdtToken.address.toLowerCase();

    // Deduplicate all tokens to query (including wrapped and USDT)
    const distinctTokenAddrs = new Map<string, number>(); // address -> decimals
    distinctTokenAddrs.set(wrappedAddress, chainConfig.nativeToken.decimals);
    distinctTokenAddrs.set(usdtAddress, chainConfig.usdtToken.decimals);

    tokens.forEach((t) => {
      if (t && t.address && ethers.isAddress(t.address)) {
        const lower = t.address.toLowerCase();
        if (!distinctTokenAddrs.has(lower)) {
          distinctTokenAddrs.set(lower, t.decimals ?? 18);
        }
      }
    });

    const tokenList = Array.from(distinctTokenAddrs.entries()).map(([addr, dec]) => ({
      address: addr,
      decimals: dec,
    }));

    return await this.executeWithRpcFallback(chainId, async (provider) => {
      const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

      // Construct batched calls:
      // Call 0: Multicall3.getEthBalance(address)
      // Calls 1..2N: for each token, 1 balanceOf call + 1 allowance call
      const calls: { target: string; allowFailure: boolean; callData: string }[] = [
        {
          target: MULTICALL3_ADDRESS,
          allowFailure: true,
          callData: MULTICALL3_INTERFACE.encodeFunctionData('getEthBalance', [address]),
        },
      ];

      tokenList.forEach((tok) => {
        // Balance query
        calls.push({
          target: tok.address,
          allowFailure: true,
          callData: ERC20_INTERFACE.encodeFunctionData('balanceOf', [address]),
        });
        // Allowance query
        calls.push({
          target: tok.address,
          allowFailure: true,
          callData: ERC20_INTERFACE.encodeFunctionData('allowance', [address, chainConfig.cowVaultRelayer]),
        });
      });

      const results = await multicall.aggregate3.staticCall(calls);

      // Parse native balance
      if (!results[0]?.success) throw new Error('Native balance subquery failed');
      const [nativeWei] = MULTICALL3_INTERFACE.decodeFunctionResult('getEthBalance', results[0].returnData);
      const nativeFormatted = ethers.formatUnits(nativeWei, chainConfig.nativeToken.decimals);

      const tokenBalances: Record<string, string> = {};
      const tokenAllowances: Record<string, boolean> = {};

      let resultIdx = 1;
      tokenList.forEach((tok) => {
        const balRes = results[resultIdx++];
        const allowRes = results[resultIdx++];

        if (!balRes?.success) throw new Error(`Balance subquery failed for ${tok.address}`);
        if (!allowRes?.success) throw new Error(`Allowance subquery failed for ${tok.address}`);
        const [balWei] = ERC20_INTERFACE.decodeFunctionResult('balanceOf', balRes.returnData);
        const [allowWei] = ERC20_INTERFACE.decodeFunctionResult('allowance', allowRes.returnData);
        const balFormatted = ethers.formatUnits(balWei, tok.decimals);
        const isAllowed = BigInt(allowWei) > 0n;

        tokenBalances[tok.address] = balFormatted;
        tokenAllowances[tok.address] = isAllowed;
      });

      return {
        nativeBalance: nativeFormatted,
        tokenBalances,
        tokenAllowances,
      };
    });
  },

  /**
   * Unified 1-shot balance and allowance query via Multicall3.
   */
  async getBalancesAndAllowances(
    address: string,
    chainId: number = DEFAULT_CHAIN_ID,
    nativePriceUsd: number = 0,
    additionalTokens: TokenConfig[] = [],
    deferValuation = false
  ): Promise<{ balances: Balances; allowances: AllowanceState }> {
    if (!address || !ethers.isAddress(address)) {
      throw balanceReadFailure(chainId, new Error('Invalid wallet address'));
    }

    try {
      const chainConfig = getChainConfig(chainId);
      const batched = await this.getBalancesAndAllowancesBatched(address, chainId, additionalTokens);

      const wrappedAddr = chainConfig.nativeToken.wrappedAddress.toLowerCase();
      const usdtAddr = chainConfig.usdtToken.address.toLowerCase();

      const nativeFormatted = batched.nativeBalance;
      const wrappedFormatted = batched.tokenBalances[wrappedAddr];
      const usdtFormatted = batched.tokenBalances[usdtAddr];
      if (wrappedFormatted === undefined || usdtFormatted === undefined) throw new Error('Required token balance missing from response');

      const tokenBalances: Record<string, string> = {
        [chainConfig.nativeToken.symbol]: nativeFormatted,
        [chainConfig.nativeToken.wrappedSymbol]: wrappedFormatted,
        [chainConfig.usdtToken.symbol]: usdtFormatted,
        [wrappedAddr]: wrappedFormatted,
        [usdtAddr]: usdtFormatted,
      };

      const hasWrappedAllowance = !!batched.tokenAllowances[wrappedAddr];
      const hasUsdtAllowance = !!batched.tokenAllowances[usdtAddr];

      const tokenAllowances: Record<string, boolean> = {
        [wrappedAddr]: hasWrappedAllowance,
        [usdtAddr]: hasUsdtAllowance,
      };

      let additionalTokensUsd = 0;
      const valuedTokens = new Set<string>();
      if (additionalTokens.length > 0) {
        await Promise.all(
          additionalTokens.map(async (tok) => {
            if (!tok || !tok.address) return;
            const lowerAddr = tok.address.toLowerCase();
            if (valuedTokens.has(lowerAddr)) return;
            valuedTokens.add(lowerAddr);
            tokenAllowances[lowerAddr] = !!batched.tokenAllowances[lowerAddr];

            if (lowerAddr === wrappedAddr || lowerAddr === usdtAddr) return;

            const rawBal = batched.tokenBalances[lowerAddr];
            if (rawBal === undefined) throw new Error(`Required balance missing for ${tok.symbol}`);
            const displayDecimals = (tok.decimals ?? 18) > 8 ? 4 : 2;
            const balNum = parseFloat(rawBal);
            tokenBalances[tok.symbol] = rawBal;
            tokenBalances[lowerAddr] = rawBal;

            if (!deferValuation && balNum > 0) {
              try {
                const p = await marketDataService.fetchTokenPrice(tok.address, chainId, tok.binanceSymbol);
                if (p && p.price > 0) {
                  additionalTokensUsd += balNum * p.price;
                }
              } catch (pErr: any) {
                throw pErr;
              }
            }
          })
        );
      }

      let effectiveNativePrice = nativePriceUsd;
      if (!deferValuation && effectiveNativePrice <= 0) {
        try {
          effectiveNativePrice = await marketDataService.fetchNativeTokenPrice(chainId);
        } catch (err: any) {
          throw err;
        }
      }

      const nativeNum = parseFloat(nativeFormatted);
      const wrappedNum = parseFloat(wrappedFormatted);
      const usdtNum = parseFloat(usdtFormatted);
      const totalUsd = (nativeNum + wrappedNum) * effectiveNativePrice + usdtNum + additionalTokensUsd;

      return {
        balances: {
          bnb: nativeFormatted,
          wbnb: wrappedFormatted,
          usdt: usdtFormatted,
          totalUsdValue: deferValuation ? '' : totalUsd.toFixed(2),
          isLoading: false,
          lastUpdated: Date.now(),
          tokenBalances,
        },
        allowances: {
          wbnbAllowed: hasWrappedAllowance,
          usdtAllowed: hasUsdtAllowance,
          isChecking: false,
          tokenAllowances,
        },
      };
    } catch (error: any) {
      systemLogService.logError(
        'NETWORK',
        `Failed to Fetch Balances and Allowances on Chain ${chainId}`,
        error?.message || String(error),
        chainId
      );
      throw balanceReadFailure(chainId, error);
    }
  },

  /** Price display enrichment separately from balance/allowance readiness. */
  async getWalletUsdValue(balances: Balances, chainId: number, tokens: TokenConfig[]): Promise<{ totalUsdValue: string; tokenPricesUsd: Record<string, number> }> {
    const chain = getChainConfig(chainId);
    const quantity = (raw: string | undefined, symbol: string): number => {
      if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) {
        throw new Error(`Wallet valuation: ${symbol} balance unavailable`);
      }
      return Number(raw);
    };
    const wrapped = chain.nativeToken.wrappedAddress.toLowerCase();
    const stable = chain.usdtToken.address.toLowerCase();
    const nativeAmount = quantity(balances.bnb, chain.nativeToken.symbol);
    const assets = new Map<string, { amount: number; symbol: string; binanceSymbol?: string }>([
      [wrapped, { amount: quantity(balances.wbnb, chain.nativeToken.wrappedSymbol), symbol: chain.nativeToken.wrappedSymbol }],
      [stable, { amount: quantity(balances.usdt, chain.usdtToken.symbol), symbol: chain.usdtToken.symbol }],
    ]);
    for (const token of tokens) {
      const address = token.address.toLowerCase();
      if ((token.chainId || DEFAULT_CHAIN_ID) !== chainId || assets.has(address)) continue;
      assets.set(address, { amount: quantity(balances.tokenBalances?.[address], token.symbol), symbol: token.symbol, binanceSymbol: token.binanceSymbol });
    }
    // Native and wrapped native share a price, but are distinct holdings.
    assets.get(wrapped)!.amount += nativeAmount;
    const tokenPricesUsd: Record<string, number> = {};
    const values = await Promise.all([...assets].map(async ([address, asset]) => {
      if (asset.amount === 0) return 0;
      const price = address === wrapped
        ? await marketDataService.fetchNativeTokenPrice(chainId)
        : (await marketDataService.fetchTokenPrice(address, chainId, asset.binanceSymbol)).price;
      const value = asset.amount * price;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(value)) {
        throw new Error(`Wallet valuation: ${asset.symbol} USD price unavailable`);
      }
      tokenPricesUsd[address] = price;
      return value;
    }));
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total)) throw new Error('Wallet USD valuation is outside the supported display range');
    return { totalUsdValue: total.toFixed(2), tokenPricesUsd };
  },

  async getBalances(
    address: string,
    chainId: number = DEFAULT_CHAIN_ID,
    nativePriceUsd: number = 0,
    additionalTokens: TokenConfig[] = []
  ): Promise<Balances> {
    const res = await this.getBalancesAndAllowances(address, chainId, nativePriceUsd, additionalTokens);
    return res.balances;
  },

  async checkAllowances(
    address: string,
    chainId: number = DEFAULT_CHAIN_ID,
    additionalTokens: TokenConfig[] = []
  ): Promise<AllowanceState> {
    const res = await this.getBalancesAndAllowances(address, chainId, 0, additionalTokens);
    return res.allowances;
  },

  async getTokenMetadata(tokenAddress: string, chainId: number = DEFAULT_CHAIN_ID): Promise<TokenConfig | null> {
    if (!ethers.isAddress(tokenAddress)) return null;
    try {
      return await this.executeWithRpcFallback(chainId, async (provider) => {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const [symbol, decimals, name] = await Promise.all([
          contract.symbol(),
          contract.decimals(),
          contract.name().catch(() => ''),
        ]);
        return {
          symbol: symbol || 'TOKEN',
          name: name || symbol || 'Custom Token',
          address: tokenAddress.toLowerCase(),
          decimals: Number(decimals),
          chainId,
          isCustom: true,
        };
      });
    } catch (e: any) {
      console.error('Failed to get token metadata:', e);
      return null;
    }
  },

  async approveToken(walletAddress: string, tokenAddress: string, chainId: number = DEFAULT_CHAIN_ID): Promise<string> {
    const chainConfig = getChainConfig(chainId);

    return await this.executeWithSignerFallback(walletAddress, chainId, async (signer, provider) => {
      const userAddress = await signer.getAddress();
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || ethers.parseUnits('5', 'gwei');
      const userNativeBal = await provider.getBalance(userAddress);
      const requiredGasWei = 65000n * gasPrice;

      if (userNativeBal < requiredGasWei) {
        const userFormatted = ethers.formatUnits(userNativeBal, chainConfig.nativeToken.decimals);
        const neededFormatted = ethers.formatUnits(requiredGasWei, chainConfig.nativeToken.decimals);
        const nativePrice = await marketDataService.fetchNativeTokenPrice(chainId).catch(() => 0);
        const neededUsd = nativePrice > 0 ? (parseFloat(neededFormatted) * nativePrice).toFixed(2) : '0.00';
        const err = `Insufficient ${chainConfig.nativeToken.symbol} for token approval gas on ${chainConfig.name}. You have ${formatTokenDisplay(userFormatted)} ${chainConfig.nativeToken.symbol}, but need ~${formatTokenDisplay(neededFormatted)} ${chainConfig.nativeToken.symbol} (~$${neededUsd} USD) to pay for network gas.`;
        systemLogService.logError('WALLET', `Approval Gas Insufficient (${chainConfig.shortName})`, err, chainId);
        throw new Error(err);
      }

      const contract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
      const maxApproval = ethers.MaxUint256;
      const allowance = BigInt(await contract.allowance(userAddress, chainConfig.cowVaultRelayer));
      if (allowance > 0n && allowance < maxApproval) await confirmedTransaction(signer, chainId, tokenAddress, contract.interface.encodeFunctionData('approve', [chainConfig.cowVaultRelayer, 0n]));
      const tx = await confirmedTransaction(signer, chainId, tokenAddress, contract.interface.encodeFunctionData('approve', [chainConfig.cowVaultRelayer, maxApproval]));
      systemLogService.logSuccess(
        'WALLET',
        `Token Approved on ${chainConfig.name}`,
        `Spender: CoW Protocol Vault Relayer`,
        tx.hash,
        chainConfig.txUrl(tx.hash),
        chainId
      );
      return tx.hash;
    });
  },

  async wrapNative(walletAddress: string, amount: string, chainId: number = DEFAULT_CHAIN_ID): Promise<string> {
    const chainConfig = getChainConfig(chainId);
    const valueWei = ethers.parseUnits(amount, chainConfig.nativeToken.decimals);

    return await this.executeWithSignerFallback(walletAddress, chainId, async (signer, provider) => {
      const userAddress = await signer.getAddress();
      const userNativeBal = await provider.getBalance(userAddress);
      const data = new ethers.Interface(WRAPPED_NATIVE_ABI).encodeFunctionData('deposit');
      const budget = await estimateTransferGas(provider, chainId, { from: userAddress, to: chainConfig.nativeToken.wrappedAddress, data, value: valueWei });
      const requiredGasWei = budget.reserveWei;

      if (userNativeBal < valueWei + requiredGasWei) {
        const userFormatted = ethers.formatUnits(userNativeBal, chainConfig.nativeToken.decimals);
        const neededFormatted = ethers.formatUnits(valueWei + requiredGasWei, chainConfig.nativeToken.decimals);
        const err = `Insufficient ${chainConfig.nativeToken.symbol} on ${chainConfig.name}. You have ${formatTokenDisplay(userFormatted)} ${chainConfig.nativeToken.symbol}, but wrapping ${formatTokenDisplay(amount)} requires ~${formatTokenDisplay(neededFormatted)} ${chainConfig.nativeToken.symbol} (including gas).`;
        systemLogService.logError('SWAP', `Wrap Insufficient Funds (${chainConfig.shortName})`, err, chainId);
        throw new Error(err);
      }

      const wrappedContract = new ethers.Contract(chainConfig.nativeToken.wrappedAddress, WRAPPED_NATIVE_ABI, signer);
      const tx = await confirmedTransaction(signer, chainId, chainConfig.nativeToken.wrappedAddress, wrappedContract.interface.encodeFunctionData('deposit'), { value: valueWei,
        beforePrepare: async () => {
          const fresh = await estimateTransferGas(provider, chainId, { from: userAddress, to: chainConfig.nativeToken.wrappedAddress, data, value: valueWei });
          if (await provider.getBalance(userAddress, 'pending') < valueWei + fresh.reserveWei) throw new Error('Native balance no longer covers wrap amount and gas reserve. Refresh MAX.');
          return gasTransactionFields(fresh);
        } });
      systemLogService.logSuccess(
        'SWAP',
        `Wrapped ${formatTokenDisplay(amount)} ${chainConfig.nativeToken.symbol} → ${chainConfig.nativeToken.wrappedSymbol}`,
        `Tx Hash: ${tx.hash}`,
        tx.hash,
        chainConfig.txUrl(tx.hash),
        chainId
      );
      return tx.hash;
    });
  },

  async unwrapNative(walletAddress: string, amount: string, chainId: number = DEFAULT_CHAIN_ID): Promise<string> {
    const chainConfig = getChainConfig(chainId);
    const wadWei = ethers.parseUnits(amount, chainConfig.nativeToken.decimals);

    return await this.executeWithSignerFallback(walletAddress, chainId, async (signer, provider) => {
      const userAddress = await signer.getAddress();
      const userNativeBal = await provider.getBalance(userAddress);
      const data = new ethers.Interface(WRAPPED_NATIVE_ABI).encodeFunctionData('withdraw', [wadWei]);
      const budget = await estimateTransferGas(provider, chainId, { from: userAddress, to: chainConfig.nativeToken.wrappedAddress, data });
      const requiredGasWei = budget.reserveWei;

      if (userNativeBal < requiredGasWei) {
        const userFormatted = ethers.formatUnits(userNativeBal, chainConfig.nativeToken.decimals);
        const neededFormatted = ethers.formatUnits(requiredGasWei, chainConfig.nativeToken.decimals);
        const nativePrice = await marketDataService.fetchNativeTokenPrice(chainId).catch(() => 0);
        const neededUsd = nativePrice > 0 ? (parseFloat(neededFormatted) * nativePrice).toFixed(2) : '0.00';
        const err = `Insufficient ${chainConfig.nativeToken.symbol} on ${chainConfig.name} for gas. You have ${formatTokenDisplay(userFormatted)} ${chainConfig.nativeToken.symbol}, but need ~${formatTokenDisplay(neededFormatted)} ${chainConfig.nativeToken.symbol} (~$${neededUsd} USD) to unwrap.`;
        systemLogService.logError('SWAP', `Unwrap Gas Insufficient (${chainConfig.shortName})`, err, chainId);
        throw new Error(err);
      }

      const wrappedContract = new ethers.Contract(chainConfig.nativeToken.wrappedAddress, WRAPPED_NATIVE_ABI, signer);
      const tx = await confirmedTransaction(signer, chainId, chainConfig.nativeToken.wrappedAddress, wrappedContract.interface.encodeFunctionData('withdraw', [wadWei]), {
        beforePrepare: async () => {
          const fresh = await estimateTransferGas(provider, chainId, { from: userAddress, to: chainConfig.nativeToken.wrappedAddress, data });
          if (await provider.getBalance(userAddress, 'pending') < fresh.reserveWei) throw new Error('Native balance no longer covers unwrap gas reserve');
          return gasTransactionFields(fresh);
        } });
      systemLogService.logSuccess(
        'SWAP',
        `Unwrapped ${formatTokenDisplay(amount)} ${chainConfig.nativeToken.wrappedSymbol} → ${chainConfig.nativeToken.symbol}`,
        `Tx Hash: ${tx.hash}`,
        tx.hash,
        chainConfig.txUrl(tx.hash),
        chainId
      );
      return tx.hash;
    });
  },

  // Legacy wrappers for backward compatibility
  async wrapBnb(walletAddress: string, amountBnb: string): Promise<string> {
    return this.wrapNative(walletAddress, amountBnb, BSC_CHAIN_ID);
  },

  async unwrapWbnb(walletAddress: string, amountWbnb: string): Promise<string> {
    return this.unwrapNative(walletAddress, amountWbnb, BSC_CHAIN_ID);
  },

  async getAllChainsBalances(
    address: string,
    trackedTokens: TokenConfig[] = [],
    onChainReport?: (report: ChainBalanceReport) => void,
  ): Promise<Record<number, ChainBalanceReport>> {
    if (!address || !ethers.isAddress(address)) throw balanceReadFailure(DEFAULT_CHAIN_ID, new Error('Invalid wallet address'));
    const reports = await Promise.all(Object.entries(SUPPORTED_CHAINS).map(async ([id, chainCfg]) => {
      const chainId = Number(id);
      let report: ChainBalanceReport;
      try {
        const chainTracked = trackedTokens.filter(token => (token.chainId || DEFAULT_CHAIN_ID) === chainId);
        const unique = chainTracked.filter((token, index) => index === chainTracked.findIndex(other => other.address.toLowerCase() === token.address.toLowerCase()));
        const batched = await this.getBalancesAndAllowancesBatched(address, chainId, unique);
        const wrappedAddr = chainCfg.nativeToken.wrappedAddress.toLowerCase();
        const usdtAddr = chainCfg.usdtToken.address.toLowerCase();
        const nativeBalance = batched.nativeBalance;
        const wrappedBalance = batched.tokenBalances[wrappedAddr] || '0';
        const usdtBalance = batched.tokenBalances[usdtAddr] || '0';
        const missingPrices: string[] = [];
        const readPrice = async (symbol: string, fetchPrice: () => Promise<number>): Promise<number | null> => {
          try {
            const price = await fetchPrice();
            if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
            return price;
          } catch {
            missingPrices.push(symbol);
            return null;
          }
        };
        const value = (balance: string, price: number | null) => Number(balance) === 0 ? 0 : price === null ? null : Number(balance) * price;
        // A price failure must not discard a successful on-chain balance read.
        const nativePrice = Number(nativeBalance) > 0 || Number(wrappedBalance) > 0
          ? await readPrice(chainCfg.nativeToken.symbol, () => marketDataService.fetchNativeTokenPrice(chainId)) : 0;
        const nativeUsd = value(nativeBalance, nativePrice);
        const wrappedUsd = value(wrappedBalance, nativePrice);
        const usdtUsd = Number(usdtBalance);
        const tokens: ChainTokenBalance[] = await Promise.all(unique.filter(token =>
          token.address.toLowerCase() !== wrappedAddr && token.address.toLowerCase() !== usdtAddr).map(async token => {
          const balance = batched.tokenBalances[token.address.toLowerCase()] || '0';
          const priceUsd = Number(balance) > 0 ? await readPrice(token.symbol, async () =>
            (await marketDataService.fetchTokenPrice(token.address, chainId, token.binanceSymbol)).price) : 0;
          return { token, balance, priceUsd, usdValue: value(balance, priceUsd) };
        }));
        const values = [nativeUsd, wrappedUsd, usdtUsd, ...tokens.map(token => token.usdValue)];
        const knownTotalChainUsd = values.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
        report = { chainId, chainConfig: chainCfg, nativeBalance, nativeUsd, wrappedBalance, wrappedUsd,
          usdtBalance, usdtUsd, usdcBalance: '0.00', usdcUsd: 0, tokens,
          totalChainUsd: values.some(amount => amount === null) ? null : knownTotalChainUsd,
          knownTotalChainUsd, nativePriceUsd: nativePrice, isLoading: false,
          ...(missingPrices.length ? { error: 'USD prices unavailable: ' + missingPrices.join(', ') } : {}),
        };
      } catch (error) {
        const message = balanceReadFailure(chainId, error).message;
        systemLogService.logError('NETWORK', 'Chain Balance Query Failed (' + chainCfg.shortName + ')', message, chainId);
        report = { chainId, chainConfig: chainCfg, nativeBalance: null, nativeUsd: null, wrappedBalance: null, wrappedUsd: null,
          usdtBalance: null, usdtUsd: null, usdcBalance: null, usdcUsd: null, tokens: [], totalChainUsd: null,
          knownTotalChainUsd: null, nativePriceUsd: null, isLoading: false, error: message };
      }
      onChainReport?.(report);
      return report;
    }));
    return Object.fromEntries(reports.map(report => [report.chainId, report]));
  },

  async getMultiChainGasFees(): Promise<Record<number, ChainGasFeeInfo>> {
    const chainEntries = Object.entries(SUPPORTED_CHAINS);
    const gasMap: Record<number, ChainGasFeeInfo> = {};

    await Promise.allSettled(
      chainEntries.map(async ([cIdStr, cfg]) => {
        const chainId = parseInt(cIdStr, 10);
        try {
          return await this.executeWithRpcFallback(chainId, async (provider) => {
            const [feeData, nativePrice] = await Promise.all([
              provider.getFeeData(),
              marketDataService.fetchNativeTokenPrice(chainId).catch(() => 0),
            ]);

            const gasPriceWei = feeData.gasPrice || feeData.maxFeePerGas || 1000000000n;
            const gasPriceGwei = parseFloat(ethers.formatUnits(gasPriceWei, 'gwei'));
            const baseFeeGwei = feeData.maxFeePerGas ? parseFloat(ethers.formatUnits(feeData.maxFeePerGas, 'gwei')) : undefined;

            // Estimate ERC-20 approval cost (45,000 gas) and Wrap cost (30,000 gas)
            const approvalGasWei = 45000n * gasPriceWei;
            const wrapGasWei = 30000n * gasPriceWei;

            const approvalCostEth = parseFloat(ethers.formatUnits(approvalGasWei, 18));
            const wrapCostEth = parseFloat(ethers.formatUnits(wrapGasWei, 18));

            const estimatedApprovalUsd = approvalCostEth * nativePrice;
            const estimatedWrapUsd = wrapCostEth * nativePrice;

            gasMap[chainId] = {
              chainId,
              chainName: cfg.name,
              shortName: cfg.shortName,
              gasPriceGwei,
              baseFeeGwei,
              estimatedApprovalUsd,
              estimatedWrapUsd,
              nativePriceUsd: nativePrice,
              lastUpdated: Date.now(),
            };
            return gasMap[chainId];
          });
        } catch (err: any) {
          systemLogService.logWarning(
            'NETWORK',
            `Gas Fee Query Note (${cfg.shortName})`,
            err?.message || String(err),
            chainId
          );
        }
      })
    );

    return gasMap;
  },
};
