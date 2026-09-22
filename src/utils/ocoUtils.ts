import { nativeStore } from '../services/nativeStore';
import { TradeOrder } from '../types/trading';

/**
 * Generates the next sequential identifier tag (e.g. A1, A2, ... A9, B1, ... Z9).
 * Derived deterministically from existing orders so it never jumps numbers on re-renders.
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_COMBINATIONS = 26 * 26 * 9; // 6,084 combinations

/**
 * Converts a sequence index (0 to 6083) to an identifier tag (AA1 to ZZ9).
 * 0 -> AA1, 8 -> AA9, 9 -> AB1, 17 -> AB9, 233 -> AZ9, 234 -> BA1 ... 6083 -> ZZ9
 */
export function indexToOcoTag(idx: number): string {
  const normalizedIdx = ((idx % MAX_COMBINATIONS) + MAX_COMBINATIONS) % MAX_COMBINATIONS;
  const num = (normalizedIdx % 9) + 1;
  const letterCombinedIdx = Math.floor(normalizedIdx / 9);
  const firstLetterIdx = Math.floor(letterCombinedIdx / 26);
  const secondLetterIdx = letterCombinedIdx % 26;
  return `${LETTERS[firstLetterIdx]}${LETTERS[secondLetterIdx]}${num}`;
}

/**
 * Parses an identifier tag back into its sequence index (-1 if not matching).
 */
export function ocoTagToIndex(tag: string): number {
  if (!tag) return -1;
  const match = tag.trim().match(/^([A-Z])([A-Z])([1-9])$/i);
  if (!match) return -1;
  const l1 = LETTERS.indexOf(match[1].toUpperCase());
  const l2 = LETTERS.indexOf(match[2].toUpperCase());
  const num = parseInt(match[3], 10);
  if (l1 < 0 || l2 < 0 || num < 1 || num > 9) return -1;
  const letterCombinedIdx = l1 * 26 + l2;
  return letterCombinedIdx * 9 + (num - 1);
}

/**
 * Generates the next sequential identifier tag:
 * Starts at AA1, AA2, ... AA9, then AB1 ... AB9, AC1 ... AZ9, BA1 ... BZ9, ... ZZ9.
 * Checks existing orders and persistent storage to guarantee monotonic progression across all order sets.
 */
export function getNextOcoTag(existingOrders: TradeOrder[] = []): string {
  let maxIdx = -1;

  // 1. Scan existing orders for the highest used AA1-ZZ9 tag
  if (existingOrders && existingOrders.length > 0) {
    for (const order of existingOrders) {
      const tag = order.ocoGroupId || (order.bracket && order.bracket.ocoGroupId);
      if (tag) {
        const idx = ocoTagToIndex(tag);
        if (idx > maxIdx) {
          maxIdx = idx;
        }
      }
    }
  }

  // 2. Scan localStorage for highest assigned counter in case orders were cleared or placed in other tabs
  try {
    if (typeof window !== 'undefined') {
      const storedLast = nativeStore.getItem('haven_defi_last_oco_tag');
      if (storedLast) {
        const storedIdx = ocoTagToIndex(storedLast);
        if (storedIdx > maxIdx) {
          maxIdx = storedIdx;
        }
      }
    }
  } catch (e) {
    // Ignore storage errors
  }

  const nextIdx = maxIdx + 1;
  const nextTag = indexToOcoTag(nextIdx);

  return nextTag;
}

/**
 * Persists the allocated tag to ensure subsequent order sets advance forward.
 */
export function recordAllocatedOcoTag(tag: string): void {
  try {
    if (typeof window !== 'undefined' && tag) {
      nativeStore.setItem('haven_defi_last_oco_tag', tag.toUpperCase());
    }
  } catch (e) {
    // Ignore storage errors
  }
}

