import { nativeStore } from './nativeStore';

const KEY = 'haven_defi_terminal_submissions_v1';
export interface Submission { uid: string; chainId: number; payload: Record<string, any>; error?: string; rejected?: boolean; purpose?: 'bridge' }
export const orderJournal = {
  all(): Submission[] { return JSON.parse(nativeStore.getItem(KEY) || '[]'); },
  async put(record: Submission) {
    nativeStore.setItem(KEY, JSON.stringify([...this.all().filter(x => x.uid !== record.uid), record]));
    await nativeStore.flush();
  },
  async remove(uid: string) { nativeStore.setItem(KEY, JSON.stringify(this.all().filter(x => x.uid !== uid))); await nativeStore.flush(); },
};
