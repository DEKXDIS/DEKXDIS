import { ethers } from 'ethers';

export const withGasMargin = (value: bigint) => (value * 125n + 99n) / 100n;
export interface TransferGas {
  gasLimit: bigint;
  reserveWei: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/** Budget the fee caps actually sent to the signer, plus rollup fees. Never invent a gas price. */
export async function estimateTransferGas(provider: ethers.Provider, chainId: number,
  transaction: ethers.TransactionRequest, quotedGasLimit?: bigint): Promise<TransferGas> {
  const fees = await provider.getFeeData();
  const rate = fees.maxFeePerGas ?? fees.gasPrice;
  if (rate == null || rate <= 0n) throw new Error('Network gas price unavailable; cannot calculate a safe transfer amount.');
  const gasLimit = quotedGasLimit ?? withGasMargin(await provider.estimateGas(transaction));
  if (gasLimit <= 0n) throw new Error('Invalid transaction gas estimate');
  const feeFields = fees.maxFeePerGas != null
    ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n }
    : { gasPrice: rate };
  let additionalFee = 0n;
  if (chainId === 8453) {
    const oracle = new ethers.Contract('0x420000000000000000000000000000000000000F', [
      'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
      'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
    ], provider);
    const unsigned = ethers.Transaction.from({ chainId, type: fees.maxFeePerGas != null ? 2 : 0,
      to: String(transaction.to), data: String(transaction.data || '0x'), value: BigInt(transaction.value?.toString() || '0'),
      gasLimit, nonce: 0, ...feeFields }).unsignedSerialized;
    const [l1, operator] = await Promise.all([
      oracle.getL1FeeUpperBound(ethers.getBytes(unsigned).length + 8), oracle.getOperatorFee(gasLimit),
    ]);
    additionalFee = BigInt(l1) + BigInt(operator);
  }
  // Arbitrum's RPC gas limit includes its L1 posting component. Base charges that separately above.
  return { gasLimit, ...feeFields, reserveWei: withGasMargin(gasLimit * rate + additionalFee) };
}

export function gasTransactionFields(gas: TransferGas): ethers.TransactionRequest {
  const { reserveWei: _, ...fields } = gas;
  return fields;
}

export function spendableNative(balance: bigint, gasReserve: bigint, extraValue = 0n): bigint {
  const amount = balance - gasReserve - extraValue;
  if (amount <= 0n) throw new Error('Native balance does not cover the transfer gas reserve.');
  return amount;
}

export async function approvalGasReserve(provider: ethers.Provider, chainId: number, owner: string,
  token: string, spender: string, amount: bigint): Promise<bigint> {
  const contract = new ethers.Contract(token, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], provider);
  const current = BigInt(await contract.allowance(owner, spender));
  if (current >= amount) return 0n;
  const tx = { from: owner, to: token, data: contract.interface.encodeFunctionData('approve', [spender, current > 0n ? 0n : amount]) };
  const gas = await estimateTransferGas(provider, chainId, tx);
  if (current === 0n) return gas.reserveWei;
  // A zero-reset requires two transactions. Budget the additional zero-to-nonzero SSTORE cost;
  // the second approval is re-estimated after the reset before signing.
  const second = await estimateTransferGas(provider, chainId,
    { ...tx, data: contract.interface.encodeFunctionData('approve', [spender, amount]) }, gas.gasLimit + 20000n);
  return gas.reserveWei + second.reserveWei;
}
