import { nativeStore } from '../services/nativeStore';
import { systemLogService } from '../services/systemLogService';
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { containDialogFocus } from './ModalDialog';
import { 
  X, 
  Key, 
  QrCode, 
  Copy, 
  Check, 
  Eye, 
  EyeOff, 
  ShieldAlert, 
  LogIn, 
  Sparkles,
  AlertTriangle,
  ExternalLink
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { WalletState } from '../types/trading';
import { getChainConfig, DEFAULT_CHAIN_ID } from '../types/chains';

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'qr' | 'export' | 'import';
  wallet: WalletState | null;
  chainId?: number;
  onImportWallet: (input: string) => Promise<void>;
  onGenerateNew: () => Promise<void>;
  onBackupConfirmed: (wallet: WalletState) => void;
}

export const WalletModal: React.FC<WalletModalProps> = ({
  isOpen,
  onClose,
  mode: initialMode,
  wallet,
  chainId = DEFAULT_CHAIN_ID,
  onImportWallet,
  onGenerateNew,
  onBackupConfirmed,
}) => {
  const [tab, setTab] = useState<'qr' | 'export' | 'import'>(initialMode);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState(false);
  const [copiedMnemonic, setCopiedMnemonic] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [backupSuffix, setBackupSuffix] = useState('');
  const [hasRevealed, setHasRevealed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const needsBackup = !!wallet?.needsBackup;

  const [secret, setSecret] = useState<{ privateKey: string; mnemonic?: string } | null>(null);
  const revealGeneration = useRef(0);
  useEffect(() => { revealGeneration.current++; setSecret(null); setShowKey(false); return () => { revealGeneration.current++; }; }, [isOpen, tab, wallet?.address]);
  useEffect(() => { setTab(needsBackup ? 'export' : initialMode); setSecret(null); setShowKey(false); setImportInput(''); setImportError(null); setBackupSuffix(''); setHasRevealed(false); }, [isOpen, initialMode, wallet?.address, needsBackup]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (isOpen && dialog && !dialog.open) dialog.showModal();
    if (!isOpen && dialog?.open) dialog.close();
    return () => { if (dialog?.open) dialog.close(); };
  }, [isOpen]);
  useEffect(() => {
    if (!secret) return;
    const timer = setTimeout(() => { setSecret(null); setShowKey(false); }, 60000);
    return () => clearTimeout(timer);
  }, [secret]);
  const reveal = async () => {
    if (showKey) { setSecret(null); setShowKey(false); return; }
    if (!wallet) return;
    const generation = ++revealGeneration.current;
    setImportError(null);
    try { const exported = await nativeStore.exportWallet(wallet.address); if (generation === revealGeneration.current) { setSecret(exported); setShowKey(true); setHasRevealed(true); } }
    catch (error) {
      if (generation !== revealGeneration.current) return;
      setImportError(String(error));
      systemLogService.logError('WALLET', 'Wallet Backup Reveal Failed', String(error));
    }
  };
  if (!isOpen) return null;

  const handleCopy = async (text: string, type: 'key' | 'addr' | 'mnemonic') => {
    try { await navigator.clipboard.writeText(text); }
    catch { setImportError('Clipboard unavailable. Select the text and copy it manually, or write it down.'); return; }
    if (type === 'key') {
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    } else if (type === 'addr') {
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    } else {
      setCopiedMnemonic(true);
      setTimeout(() => setCopiedMnemonic(false), 2000);
    }
  };

  const handleDoImport = async () => {
    if (busy) return;
    setImportError(null);
    if (!importInput.trim()) {
      setImportError('Please enter a private key or mnemonic phrase.');
      return;
    }

    setBusy(true);
    try {
      await onImportWallet(importInput.trim());
      setImportInput('');
      onClose();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const confirmBackup = async () => {
    if (!wallet || !hasRevealed || busy) return;
    setBusy(true); setImportError(null);
    try {
      const confirmed = await nativeStore.confirmBackup(wallet.address, backupSuffix.trim());
      setSecret(null); setShowKey(false); setBackupSuffix('');
      onBackupConfirmed(confirmed);
      onClose();
    } catch (error) { setImportError(String(error)); }
    finally { setBusy(false); }
  };

  return (
    <dialog ref={dialogRef} aria-labelledby="wallet-dialog-title"
      onKeyDown={containDialogFocus}
      onCancel={event => { if (needsBackup || busy) event.preventDefault(); else onClose(); }}
      className="m-auto p-0 bg-transparent text-slate-200 w-[calc(100%-2rem)] max-w-lg backdrop:bg-black/80 backdrop:backdrop-blur-sm select-text">
      <div className="bg-surface border border-surface-border rounded-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-surface-border bg-surface-hover/30">
          <div className="flex items-center gap-2">
            {tab === 'qr' && <QrCode className="w-5 h-5 text-bnb-yellow" />}
            {tab === 'export' && <Key className="w-5 h-5 text-amber-400" />}
            {tab === 'import' && <LogIn className="w-5 h-5 text-cyan-400" />}
            <h3 id="wallet-dialog-title" className="font-bold text-base text-white">
              {tab === 'qr' ? 'Deposit to Wallet' : tab === 'export' ? needsBackup ? 'Back Up Your Wallet Before You Start' : 'Wallet Backup & Private Key' : 'Import Wallet'}
            </h3>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close wallet"
            title="Close"
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-surface-border transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-surface-border bg-background/50 p-1">
          {wallet && (
            <>
              <button
                onClick={() => setTab('qr')}
                disabled={needsBackup || busy}
                title={needsBackup ? 'Confirm your private-key backup first' : undefined}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  tab === 'qr' ? 'bg-surface text-bnb-yellow shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <QrCode className="w-3.5 h-3.5" />
                <span>Deposit QR</span>
              </button>
              <button
                onClick={() => setTab('export')}
                className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
                  tab === 'export' ? 'bg-surface text-amber-400 shadow' : 'text-slate-400 hover:text-white'
                }`}
              >
                <Key className="w-3.5 h-3.5" />
                <span>Backup Key</span>
              </button>
            </>
          )}
          <button
            onClick={() => setTab('import')}
            disabled={busy}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all ${
              tab === 'import' ? 'bg-surface text-cyan-400 shadow' : 'text-slate-400 hover:text-white'
            }`}
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Import / Switch</span>
          </button>
        </div>

        {/* Modal Content */}
        <div className="p-5 overflow-y-auto space-y-4">
          {importError && <p id="wallet-import-error" role="alert" className="text-xs text-rose-400">{importError}</p>}
          
          {/* TAB 1: DEPOSIT QR */}
          {tab === 'qr' && wallet && (
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="p-4 bg-white rounded-2xl shadow-xl">
                <QRCodeSVG
                  value={wallet.address}
                  size={200}
                  level="H"
                  includeMargin={false}
                />
              </div>

              <div className="w-full">
                <div className="text-xs text-slate-400 mb-1 font-mono">
                  Your {getChainConfig(chainId).name} Deposit Address:
                </div>
                <div className="flex items-center gap-2 p-2.5 rounded-xl bg-background border border-surface-border">
                  <span className="font-mono text-xs text-slate-200 break-all select-all flex-1 text-left">
                    {wallet.address}
                  </span>
                  <button
                    onClick={() => handleCopy(wallet.address, 'addr')}
                    className="p-2 rounded-lg bg-surface hover:bg-surface-border text-slate-300 hover:text-white transition-colors shrink-0"
                    title="Copy Address"
                  >
                    {copiedAddress ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-left text-xs text-amber-300 space-y-1 w-full">
                <div className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
                  <span>Transfer Instructions</span>
                </div>
                <p className="text-[11px] text-amber-200/90 leading-relaxed">
                  Send <strong>{getChainConfig(chainId).nativeToken.symbol}</strong> or <strong>{getChainConfig(chainId).usdtToken.symbol}</strong> from your exchange or wallet on the <strong>{getChainConfig(chainId).name}</strong> network.
                </p>
              </div>

              <a
                href={getChainConfig(chainId).addressUrl(wallet.address)}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-cyan-400 hover:underline flex items-center gap-1 font-mono"
              >
                <span>View address on {getChainConfig(chainId).explorerName}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          {/* TAB 2: EXPORT BACKUP */}
          {tab === 'export' && wallet && (
            <div className="space-y-4">
              <div className="text-sm text-slate-200 space-y-2">
                <p>{needsBackup ? 'Your wallet is saved on this computer. Click Reveal to show your private key and any saved seed phrase. Write down the complete backup in a safe place so you can restore this wallet if this computer or Windows account is lost.' : 'Click Reveal to show your private key and any saved seed phrase. Either can restore this same wallet in DEKXDIS or another compatible wallet.'}</p>
                <p className="text-xs text-slate-400">New wallets include a 12-word seed phrase. Record the words in their numbered order. The deposit address cannot restore your wallet.</p>
                <p className="font-mono text-xs break-all">Wallet: {wallet.address}</p>
              </div>
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <strong>Security Warning:</strong> Never share your private key or seed phrase with anyone. Anyone with your private key has full control of funds in this wallet.
                </div>
              </div>

              {/* Private Key */}
              <div>
                <div className="flex items-center justify-between text-xs text-slate-400 mb-1 font-mono">
                  <span>Private Key (Hex):</span>
                  <button
                    onClick={reveal}
                    className="text-slate-400 hover:text-white flex items-center gap-1 text-[11px]"
                  >
                    {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showKey ? 'Hide' : 'Reveal'}</span>
                  </button>
                </div>
                <div className="flex items-center gap-2 p-2.5 rounded-xl bg-background border border-surface-border">
                  <span className="font-mono text-xs text-slate-200 break-all select-all flex-1">
                    {showKey ? secret?.privateKey : '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••'}
                  </span>
                  <button
                    onClick={() => handleCopy(secret?.privateKey || '', 'key')}
                    className="p-2 rounded-lg bg-surface hover:bg-surface-border text-slate-300 hover:text-white transition-colors shrink-0"
                    disabled={!secret}
                    title="Copy Private Key"
                  >
                    {copiedKey ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Mnemonic Seed Phrase if available */}
              {showKey && secret?.mnemonic && (
                <div>
                  <div className="text-xs text-slate-400 mb-1 font-mono">
                    Secret Recovery Phrase:
                  </div>
                  <div className="p-3 rounded-xl bg-background border border-surface-border relative">
                    <div className="grid grid-cols-3 gap-2">
                      {secret?.mnemonic.split(' ').map((word, idx) => (
                        <div key={idx} className="p-1.5 rounded-lg bg-surface text-center font-mono text-xs text-slate-200 border border-surface-border/50">
                          <span className="text-slate-500 text-[10px] mr-1">{idx + 1}.</span>
                          {word}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => handleCopy(secret?.mnemonic || '', 'mnemonic')}
                      className="mt-3 w-full py-2 rounded-lg bg-surface hover:bg-surface-border text-xs font-semibold text-slate-200 hover:text-white flex items-center justify-center gap-1.5 transition-colors border border-surface-border"
                    >
                      {copiedMnemonic ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedMnemonic ? 'Phrase Copied' : 'Copy Recovery Phrase'}</span>
                    </button>
                  </div>
                </div>
              )}
              {showKey && secret && !secret.mnemonic && <p className="text-xs text-slate-400">No seed phrase is stored for this wallet. Wallets created by older versions without a phrase, or imported using only a private key, must be restored with their private key.</p>}
              <p className="text-xs text-slate-400">The private key and seed phrase hide after 60 seconds; you can reveal them again. Copying also puts them in your system clipboard and possibly clipboard history.</p>
              {needsBackup && <div className="space-y-3 border-t border-surface-border pt-4">
                <label htmlFor="wallet-backup-check" className="block text-xs text-slate-200">Check your written backup: enter the last 6 characters of your private key.</label>
                <input id="wallet-backup-check" value={backupSuffix} maxLength={6} autoComplete="off" spellCheck={false}
                  onChange={event => setBackupSuffix(event.target.value)}
                  className="w-full rounded-lg bg-background border border-surface-border p-2 font-mono text-sm" />
                <button onClick={confirmBackup} disabled={busy || !hasRevealed || backupSuffix.trim().length !== 6}
                  className="w-full py-3 rounded-xl bg-bnb-yellow text-black font-bold text-sm disabled:opacity-40">
                  {busy ? 'Saving backup confirmation…' : 'I wrote down my private key — Continue'}
                </button>
              </div>}
            </div>
          )}

          {/* TAB 3: IMPORT / SWITCH WALLET */}
          {tab === 'import' && (
            <div className="space-y-4">
              <div>
                <label htmlFor="wallet-import-input" className="block text-xs font-medium text-slate-300 mb-1">
                  Enter Private Key or Recovery Phrase
                </label>
                <textarea
                  id="wallet-import-input"
                  rows={3}
                  value={importInput}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(importError)}
                  aria-describedby={importError ? 'wallet-import-error' : undefined}
                  onChange={(e) => { setImportInput(e.target.value); if (importError) setImportError(null); }}
                  placeholder="Paste 0x... private key or 12 words separated by spaces"
                  className="w-full bg-background border border-surface-border rounded-xl p-3 text-xs font-mono text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <button
                onClick={handleDoImport}
                disabled={busy}
                className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white font-bold text-sm transition-all shadow-glow-cyan flex items-center justify-center gap-2"
              >
                <LogIn className="w-4 h-4" />
                <span>Import & Activate Wallet</span>
              </button>

              <div className="relative flex py-2 items-center">
                <div className="flex-grow border-t border-surface-border"></div>
                <span className="flex-shrink mx-4 text-xs text-slate-500 font-mono">OR</span>
                <div className="flex-grow border-t border-surface-border"></div>
              </div>

              <button
                disabled={busy}
                onClick={async () => {
                  if (busy) return;
                  setBusy(true); setImportError(null);
                  try { await onGenerateNew(); setTab('export'); }
                  catch (error) {
                    setImportError(String(error));
                    systemLogService.logError('WALLET', 'Wallet Generation Failed', String(error));
                  }
                  finally { setBusy(false); }
                }}
                className="w-full py-3 rounded-xl bg-surface border border-surface-border hover:border-amber-400/60 text-bnb-yellow font-semibold text-sm transition-all flex items-center justify-center gap-2"
              >
                <Sparkles className="w-4 h-4" />
                <span>Generate Brand New Wallet</span>
              </button>
            </div>
          )}

        </div>
      </div>
    </dialog>
  );
};
