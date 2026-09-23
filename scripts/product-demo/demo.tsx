// Isolated browser-only verification fixture. No native vault or live orders.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { nativeStore } from '../../src/services/nativeStore';
import { storageService } from '../../src/services/storageService';
import { marketDataService } from '../../src/services/marketDataService';
import { binanceWebSocketService } from '../../src/services/binanceWebSocketService';
import { web3Service } from '../../src/services/web3Service';
import { rpcService } from '../../src/services/rpcService';
import { executionEngine } from '../../src/services/executionEngine';
import { cowProtocol } from '../../src/services/cowProtocol';
import { getChainConfig, getTradingQuoteToken, getTokensForChain } from '../../src/types/chains';
import { ethers } from 'ethers';
import { DEFAULT_BSC_TOKENS } from '../../src/types/trading';
DEFAULT_BSC_TOKENS.forEach(token => { token.logoUrl = undefined; });
import marketCandles from './candles.json';
import alphaList from './alpha-tokens.json';

const wallet = { address: '0x000000000000000000000000000000000000dEaD', needsBackup: false };
const controls = { failBalance: false, failPrice: false, balanceCalls: 0, submissions: 0, release: () => {}, price: 724.5, wrappedBalance: undefined as string | undefined };
(window as any).fixture = controls;
(window as any).readLayouts = () => storageService.getWindowLayouts();
(window as any).readOrders = () => storageService.getOrders();
nativeStore.openReadOnly('Product demonstration');
nativeStore.getWallet = () => new URLSearchParams(location.search).has('no-wallet') ? null : wallet;
nativeStore.isHealthy = () => true;
nativeStore.exportWallet = async () => ({ privateKey: 'EXAMPLE ONLY — your private key appears here', mnemonic: 'example only never use these words to store or receive real funds' });
storageService.saveSelectedChainId(56);
storageService.saveSelectedToken({...getTokensForChain(56).find(t => t.symbol === 'CAKE')!, logoUrl: undefined});
storageService.saveIsOverviewOpen(false);
storageService.saveIsLadderOpen(false);
storageService.saveChartSettings({ interval: '15m', showVolume: true, showEMA: true, showRSI: false, showMACD: false, showZScore: false, showSR: false, showDonchian: false, showZigZag: false });
storageService.saveLimitSettings({ defaultUsdAmount: '50', tpEnabled: false, tpPercent: 2, slEnabled: false, slPercent: 2 });
if (new URLSearchParams(location.search).has('saved-layout')) {
  storageService.saveWindowLayouts(Object.fromEntries(['chart', 'orders', 'ladder', 'wallet', 'trading'].map((id, i) => [id,
    { id, title: 'Saved ' + id, x: 25 + i * 20, y: 30 + i * 50, width: 600, height: 250, zIndex: 10 + i }])));
}
rpcService.init = () => {};
binanceWebSocketService.subscribePrice = () => () => {};
binanceWebSocketService.subscribeKline = () => () => {};
const tokenMap = new Map<number, any[]>();
for (const item of alphaList.data) { const id = Number(item.chainId); if (![56,1,42161,8453,100].includes(id)) continue; const list = tokenMap.get(id) || []; list.push({symbol:item.symbol,name:item.name,address:item.contractAddress,decimals:Number(item.decimals),chainId:id,isAlpha:true,alphaId:item.alphaId,binanceSymbol:item.alphaId+'USDT'}); tokenMap.set(id,list); }
marketDataService.fetchAllBinanceAlphaTokens = async () => tokenMap;
marketDataService.fetchNativeTokenPrice = async () => {
  if (controls.failPrice) throw new Error('Mock native price failure');
  return controls.price;
};
const lastClose = Number(marketCandles.at(-1)![4]);
marketDataService.fetchTokenPrice = async (address, chainId) => ({ price: address.toLowerCase() === getTradingQuoteToken(chainId).address.toLowerCase() ? controls.price : address.toLowerCase() === getChainConfig(chainId).usdtToken.address.toLowerCase() ? 1 : lastClose, change24h: (lastClose / Number(marketCandles[marketCandles.length-97][4]) - 1)*100, high24h: Math.max(...marketCandles.slice(-96).map(k=>Number(k[2]))), low24h: Math.min(...marketCandles.slice(-96).map(k=>Number(k[3]))), volume24h: marketCandles.slice(-96).reduce((sum,k)=>sum+Number(k[7]),0), lastUpdated:Date.now(),symbol:'CAKE' });
marketDataService.fetchCandles = async () => ({candles:marketCandles.map(k=>({time:Number(k[0])/1000,open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4])})),volume:marketCandles.map(k=>({time:Number(k[0])/1000,value:Number(k[5]),color:Number(k[4])>=Number(k[1])?'#10b98166':'#f43f5e66'}))}) as any;
web3Service.getBalancesAndAllowances = async (_owner, chainId, _price, tokens) => {
  controls.balanceCalls++;
  if (controls.failBalance) throw new Error('Mock balance refresh failure');
  const chain = getChainConfig(chainId);
  const tokenBalances = Object.fromEntries((tokens || []).flatMap(t => [[t.address.toLowerCase(), '120'], [t.symbol, '120']]));
  tokenBalances[chain.nativeToken.wrappedAddress.toLowerCase()] = controls.wrappedBalance ?? (chainId === 56 ? '2.4' : '0.125');
  tokenBalances[chain.usdtToken.address.toLowerCase()] = '10';
  return { balances: { bnb: '0.035', wbnb: tokenBalances[chain.nativeToken.wrappedAddress.toLowerCase()], usdt: '10', totalUsdValue: '236',
    isLoading: false, lastUpdated: Date.now(), tokenBalances },
    allowances: { wbnbAllowed: true, usdtAllowed: true, isChecking: false, tokenAllowances: {} } };
};
web3Service.getSigner = () => ({ address: wallet.address }) as any;
web3Service.getTokenBalanceWei = async () => ethers.parseEther('0.25');
web3Service.ensureAllowance = async () => {};
executionEngine.tick = async () => {};
cowProtocol.getQuote = async params => ({ quote: { sellToken: params.sellToken, buyToken: params.buyToken,
  sellAmount: ethers.parseUnits(params.amount, params.sellTokenDecimals).toString(), buyAmount: ethers.parseEther('1').toString(),
  feeAmount: '0', validTo: Math.floor(Date.now()/1000) + 1800 }, id: 1 }) as any;
cowProtocol.signAndSubmitOrder = async (_quote, _signer, _slippage, _chain, prepared) => {
  controls.submissions++;
  await new Promise<void>(resolve => { controls.release = resolve; });
  await prepared?.('mock-order');
  return 'mock-order';
};
cowProtocol.submitLimitOrder = async (params) => { controls.submissions++; const uid = '0x' + 'ab'.repeat(56); await new Promise(resolve=>setTimeout(resolve,550)); await params.onPrepared?.(uid); return uid; };
const { default: App } = await import('../../src/App');
const scene = new URLSearchParams(location.search).get('scene');
const { AssetSendModal } = await import('../../src/components/overview/AssetSendModal');
const { WalletModal } = await import('../../src/components/WalletModal');
const noop = () => {};
createRoot(document.getElementById('root')!).render(<React.StrictMode>{scene === 'send'
  ? <AssetSendModal from={wallet.address} asset={{kind:'native',chainId:56,symbol:'BNB',decimals:18}} displayPrice={724.5} onClose={noop} onRefresh={noop}/>
  : scene === 'backup' ? <WalletModal isOpen mode="export" wallet={wallet} chainId={56} onClose={noop} onImportWallet={async()=>{}} onGenerateNew={async()=>{}} onBackupConfirmed={noop}/>
  : <App />}</React.StrictMode>);
