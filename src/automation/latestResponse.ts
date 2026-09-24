export interface LatestResponse { lastResponse?: string; respondedAt?: number }
const storageKey = (key: string) => 'dekxdis_automation_latest_response_v1:' + key;
export function readLatestResponse(key: string): LatestResponse {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(key)) || 'null');
    return typeof value?.lastResponse === 'string' && Number.isFinite(value.respondedAt)
      ? { lastResponse: value.lastResponse, respondedAt: value.respondedAt } : {};
  } catch { return {}; }
}
export function saveLatestResponse(key: string, response: Required<LatestResponse>) {
  // One text response per workspace, overwritten in place. No image, input packet or transcript.
  try { localStorage.setItem(storageKey(key), JSON.stringify(response)); }
  catch (error) { console.warn('Latest response is available for this session but could not be saved', error); }
}
