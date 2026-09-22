import { ethers } from 'ethers';

// Keep provider diagnostics without serializing signers, credentials or signed payloads.
export function operationErrorDetails(error: unknown): string {
  const details = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (value: any, depth = 0) => {
    if (value == null || seen.has(value) || depth > 5) return;
    seen.add(value);
    if (typeof value === 'string') { details.add(value); return; }
    for (const key of ['message', 'shortMessage', 'reason', 'code', 'transactionHash']) {
      if (typeof value[key] === 'string' || typeof value[key] === 'number') details.add(`${key}: ${value[key]}`);
    }
    if (typeof value.data === 'string' && value.data.startsWith('0x')) {
      details.add(`Revert data: ${value.data}`);
      try {
        const decoded = new ethers.Interface(['error Error(string)', 'error Panic(uint256)']).parseError(value.data);
        if (decoded?.name === 'Panic') {
          const code = BigInt(decoded.args[0]);
          details.add(`Contract panic 0x${code.toString(16)}${code === 0x11n ? ': arithmetic overflow or underflow' : ''}`);
        } else if (decoded?.name === 'Error') details.add(`Contract reason: ${decoded.args[0]}`);
      } catch { /* The raw revert data above is retained for unknown/custom errors. */ }
    }
    if (value.receipt) {
      const receipt = value.receipt;
      details.add(`Receipt: status ${receipt.status}; block ${receipt.blockNumber}; gas used ${receipt.gasUsed}; transaction ${receipt.hash}`);
    }
    visit(value.cause, depth + 1);
    visit(value.error, depth + 1);
    visit(value.info?.error, depth + 1);
    if (value.data && typeof value.data === 'object') visit(value.data, depth + 1);
  };
  visit(error);
  return [...details].join('\n') || String(error);
}
