import { ethers } from 'ethers';
import { invoke } from '@tauri-apps/api/core';
import { nativeStore } from './nativeStore';

/** ethers-compatible signer; the private key remains inside the native vault. */
export class NativeSigner extends ethers.AbstractSigner {
  constructor(readonly address: string, provider: ethers.Provider | null, readonly chainId: number) { super(provider); }
  getAddress() { return Promise.resolve(this.address); }
  connect(provider: ethers.Provider | null) { return new NativeSigner(this.address, provider, this.chainId); }
  private async signDigest(digest: string) {
    await nativeStore.flush();
    if (!nativeStore.isHealthy() || nativeStore.getWallet()?.address.toLowerCase() !== this.address.toLowerCase()) throw new Error('Wallet changed or secure storage unavailable');
    return invoke<string>('wallet_sign', { address: this.address, digest });
  }
  signMessage(message: string | Uint8Array) { return this.signDigest(ethers.hashMessage(message)); }
  async signTypedData(domain: ethers.TypedDataDomain, types: Record<string, ethers.TypedDataField[]>, value: Record<string, any>) {
    if (Number(domain.chainId) !== this.chainId) throw new Error('Signing chain mismatch');
    return this.signDigest(ethers.TypedDataEncoder.hash(domain, types, value));
  }
  async signTransaction(request: ethers.TransactionRequest) {
    const resolved = await ethers.resolveProperties(request);
    if (resolved.from && String(resolved.from).toLowerCase() !== this.address.toLowerCase()) throw new Error('Transaction sender mismatch');
    if (Number(resolved.chainId) !== this.chainId) throw new Error('Transaction chain mismatch');
    const { from: _, ...fields } = resolved;
    const tx = ethers.Transaction.from(fields as ethers.TransactionLike<string>);
    tx.signature = await this.signDigest(tx.unsignedHash);
    return tx.serialized;
  }
}
