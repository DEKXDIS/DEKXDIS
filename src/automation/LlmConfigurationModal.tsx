import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ModalDialog } from '../components/ModalDialog';
import { blankLlmConfig, credentialScope, llmProfiles, profileAssignments,
  type ApiFormat, type LlmConfig, type LlmProfile, type LlmProfileInput, type LlmProfiles } from './llmProfiles';
import { llmPresets } from './llmPresets';

const inputClass = 'w-full min-w-0 rounded-lg border border-surface-border bg-background px-3 py-2 text-slate-100 focus:outline-none focus:border-theme-primary';
const buttonClass = 'btn-tactile rounded-lg border border-surface-border bg-surface px-3 py-2 hover:border-theme-primary disabled:opacity-50';
type Numbers = 'maxOutputTokens' | 'timeoutSeconds' | 'temperature' | 'thinkingBudget';
type Draft = Omit<LlmConfig, Numbers | 'extraBody'> & Record<Numbers, string> & { extraBody: string };
function toDraft(config: LlmConfig): Draft {
  return { ...config, maxOutputTokens: config.maxOutputTokens?.toString() ?? '', timeoutSeconds: String(config.timeoutSeconds),
    temperature: config.temperature?.toString() ?? '', thinkingBudget: config.thinkingBudget?.toString() ?? '', extraBody: JSON.stringify(config.extraBody, null, 2) };
}
function optionalNumber(value: string, label: string, integer = true): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) throw new Error(`${label} must be a valid ${integer ? 'whole ' : ''}number`);
  return number;
}
function jsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value.trim() || '{}'); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}
function toConfig(draft: Draft): LlmConfig {
  const timeoutSeconds = optionalNumber(draft.timeoutSeconds, 'Request timeout');
  if (timeoutSeconds === null) throw new Error('Enter a request timeout');
  return { ...draft, name: draft.name.trim(), model: draft.model.trim(), baseUrl: draft.baseUrl.trim(), endpoint: draft.endpoint.trim(),
    authHeader: draft.authHeader.trim(), maxOutputTokens: optionalNumber(draft.maxOutputTokens, 'Maximum output tokens'), timeoutSeconds,
    temperature: optionalNumber(draft.temperature, 'Temperature', false), thinkingBudget: optionalNumber(draft.thinkingBudget, 'Thinking budget'),
    extraBody: jsonObject(draft.extraBody, 'Additional request parameters') };
}
function Field({ label, value, onChange, placeholder, type = 'text', inputMode }: {
  label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string; inputMode?: 'numeric' | 'decimal';
}) {
  return <label className="block space-y-1"><span>{label}</span><input className={inputClass} type={type} value={value}
    onChange={event => onChange(event.target.value)} placeholder={placeholder} inputMode={inputMode} autoComplete="off" spellCheck={false} /></label>;
}
interface Props {
  profiles: LlmProfiles; selectedId: string; running: boolean;
  onProfilesChange: (profiles: LlmProfiles) => void; onUse: (profile: LlmProfile) => void; onClose: () => void;
}
export function LlmConfigurationModal({ profiles, selectedId, running, onProfilesChange, onUse, onClose }: Props) {
  const initial = profiles.profiles.find(p => p.id === selectedId);
  const [editing, setEditing] = useState<LlmProfile | undefined>(initial);
  const [draft, setDraft] = useState(() => toDraft(initial?.config ?? blankLlmConfig));
  const [presetId, setPresetId] = useState('');
  const [credentialId, setCredentialId] = useState(initial?.credentialId ?? '');
  const [apiKey, setApiKey] = useState('');
  const [replaceHeaders, setReplaceHeaders] = useState(false);
  const [headers, setHeaders] = useState('{}');
  const [makeDefault, setMakeDefault] = useState(initial?.id === profiles.defaultProfileId);
  const [operation, setOperation] = useState<'save' | 'test' | 'delete' | null>(null);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = operation !== null;
  const notice = (text: string, ok = false) => { setMessage(text); setSuccess(ok); };
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => { setDraft(old => ({ ...old, [key]: value })); setMessage(''); };
  const scope = credentialScope(draft);
  const compatibleKeys = profiles.credentials.filter(c => c.scope === scope);
  const efforts = draft.format === 'anthropic' ? ['low', 'medium', 'high', 'max']
    : draft.format === 'gemini' ? ['minimal', 'low', 'medium', 'high'] : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  function selectProfile(profile?: LlmProfile) {
    setEditing(profile); setDraft(toDraft(profile?.config ?? blankLlmConfig)); setPresetId('');
    setCredentialId(profile?.credentialId ?? ''); setApiKey(''); setHeaders('{}'); setReplaceHeaders(false);
    setMakeDefault(!!profile && profile.id === profiles.defaultProfileId); setMessage('');
  }
  function choosePreset(id: string) {
    selectProfile(); setPresetId(id);
    const config = llmPresets.find(p => p.id === id)?.config ?? blankLlmConfig;
    setDraft(toDraft(config));
    const keys = profiles.credentials.filter(c => c.scope === credentialScope(config));
    if (keys.length === 1) setCredentialId(keys[0].id);
  }
  function changeFormat(format: ApiFormat) {
    const defaults = format === 'responses' ? { endpoint: '/v1/responses', authMode: 'bearer' as const, authHeader: '', apiVersion: '' }
      : format === 'anthropic' ? { endpoint: '/v1/messages', authMode: 'header' as const, authHeader: 'x-api-key', apiVersion: '2023-06-01' }
      : format === 'gemini' ? { endpoint: '/v1beta/models/{model}:generateContent', authMode: 'header' as const, authHeader: 'x-goog-api-key', apiVersion: '' }
      : { endpoint: '/v1/chat/completions', authMode: 'bearer' as const, authHeader: '', apiVersion: '' };
    setDraft(old => ({ ...old, ...defaults, format, authPrefix: '', reasoningEffort: '', thinkingBudget: '' }));
    setCredentialId(''); setMessage('');
  }
  function input(saveAsNew = false): LlmProfileInput {
    const config = toConfig(draft);
    let customHeaders: Record<string, string> | null = null;
    if (replaceHeaders) {
      const parsed = jsonObject(headers, 'Custom headers');
      if (Object.values(parsed).some(v => typeof v !== 'string')) throw new Error('Custom header values must be strings');
      customHeaders = parsed as Record<string, string>;
    }
    return { id: editing?.id ?? null, expectedRevision: editing?.revision ?? null, saveAsNew, config,
      credentialId: credentialId || null, newKey: apiKey.trim() || null, headers: customHeaders, makeDefault };
  }
  async function save(saveAsNew = false, use = false) {
    setOperation('save'); notice('');
    try {
      const result = await llmProfiles.save(input(saveAsNew));
      if (!mounted.current) return;
      onProfilesChange(result.list);
      const saved = result.list.profiles.find(p => p.id === result.id)!;
      selectProfile(saved); setMakeDefault(result.list.defaultProfileId === saved.id);
      notice('Configuration saved', true);
      if (use) { onUse(saved); onClose(); }
    } catch (error) { if (mounted.current) notice(String(error instanceof Error ? error.message : error)); }
    finally { if (mounted.current) setOperation(null); }
  }
  async function test() {
    setOperation('test'); notice('Checking connection, image input and JSON response…');
    try { const result = await llmProfiles.test(input()); if (mounted.current) notice(result, true); }
    catch (error) { if (mounted.current) notice(String(error instanceof Error ? error.message : error)); }
    finally { if (mounted.current) setOperation(null); }
  }
  async function remove() {
    if (!editing) return;
    if (profileAssignments(editing.id).length) { notice('Select another configuration for the strategies using this one before deleting it.'); return; }
    setOperation('delete'); notice('');
    try { const list = await llmProfiles.delete(editing.id); if (mounted.current) { onProfilesChange(list); selectProfile(); notice('Configuration deleted. The saved API key is still available.', true); } }
    catch (error) { if (mounted.current) notice(String(error instanceof Error ? error.message : error)); }
    finally { if (mounted.current) setOperation(null); }
  }
  return <ModalDialog label="Configure LLM" onClose={onClose} busy={operation === 'save' || operation === 'delete'}>
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-3 sm:p-6 text-slate-300">
      <section className="flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-2xl border border-surface-border bg-surface shadow-2xl text-sm">
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h2 className="font-semibold text-theme-primary text-base">Configure LLM</h2>
          <button type="button" aria-label="Close LLM configuration" className="rounded p-1 hover:bg-background disabled:opacity-50" disabled={operation === 'save' || operation === 'delete'} onClick={onClose}><X size={20} /></button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          <fieldset disabled={busy} className="space-y-4 disabled:opacity-70">
            <label className="block space-y-1"><span>Preconfigured model</span>
              <select autoFocus className={inputClass} value={presetId} onChange={e => choosePreset(e.target.value)}>
                <option value="">Custom configuration</option>
                {[...new Set(llmPresets.map(p => p.provider))].map(provider => <optgroup key={provider} label={provider}>
                  {llmPresets.filter(p => p.provider === provider).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </optgroup>)}
              </select>
            </label>
            <label className="block space-y-1"><span>Saved configurations</span><select className={inputClass} value={editing?.id ?? ''}
              onChange={e => selectProfile(profiles.profiles.find(p => p.id === e.target.value))}>
              <option value="">New configuration</option>
              {[...profiles.profiles].sort((a, b) => a.config.name.localeCompare(b.config.name)).map(p => <option key={p.id} value={p.id}>
                {p.config.name}{p.id === profiles.defaultProfileId ? ' · Default' : ''}{!p.ready ? ' · API key needed' : ''}
              </option>)}
            </select></label>
            <div className="border-t border-surface-border pt-4 space-y-4">
              <Field label="Configuration name" value={draft.name} onChange={v => field('name', v)} placeholder="My chart analysis model" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1"><span>API format</span><select className={inputClass} value={draft.format} onChange={e => changeFormat(e.target.value as ApiFormat)}>
                  <option value="responses">OpenAI Responses</option><option value="chat-completions">OpenAI-compatible Chat Completions</option>
                  <option value="anthropic">Anthropic Messages</option><option value="gemini">Google Gemini</option>
                </select></label>
                <Field label="Model ID" value={draft.model} onChange={v => field('model', v)} placeholder="Image-capable model ID" />
                <Field label="Server / base URL" value={draft.baseUrl} onChange={v => field('baseUrl', v)} placeholder="https://api.example.com" />
                <Field label="Endpoint path" value={draft.endpoint} onChange={v => field('endpoint', v)} placeholder="/v1/chat/completions" />
              </div>
              <p className="text-xs text-slate-400">The model must accept chart images. Presets fill in the connection details; every field can be customized.</p>
              {draft.authMode !== 'none' && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block space-y-1"><span>Saved API key</span><select className={inputClass} value={credentialId} onChange={e => { setCredentialId(e.target.value); setApiKey(''); setMessage(''); }}>
                  <option value="">Enter a new key</option>
                  {credentialId && !compatibleKeys.some(k => k.id === credentialId) && <option value={credentialId} disabled>Previous key — different connection</option>}
                  {compatibleKeys.map(k => <option value={k.id} key={k.id}>{k.label}</option>)}
                </select></label>
                <Field label={credentialId ? 'Replacement API key (optional)' : 'API key'} type="password" value={apiKey} onChange={v => { setApiKey(v); setMessage(''); }} placeholder={credentialId ? 'Saved in Windows' : 'Paste your API key'} />
              </div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Maximum output tokens" value={draft.maxOutputTokens} onChange={v => field('maxOutputTokens', v)} inputMode="numeric" placeholder={draft.format === 'anthropic' ? '4096' : 'Provider default'} />
                <Field label="Request timeout (seconds)" value={draft.timeoutSeconds} onChange={v => field('timeoutSeconds', v)} inputMode="numeric" />
              </div>
              <details className="rounded-lg border border-surface-border p-3">
                <summary className="cursor-pointer text-theme-secondary">Advanced settings</summary>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block space-y-1"><span>Authentication</span><select className={inputClass} value={draft.authMode} onChange={e => { field('authMode', e.target.value as LlmConfig['authMode']); setCredentialId(''); }}>
                      <option value="bearer">Bearer API key</option><option value="header">Custom API-key header</option><option value="none">None (local server)</option>
                    </select></label>
                    {draft.authMode === 'header' && <><Field label="Authentication header" value={draft.authHeader} onChange={v => field('authHeader', v)} placeholder="x-api-key" />
                      <Field label="Key prefix (optional)" value={draft.authPrefix} onChange={v => field('authPrefix', v)} placeholder="Leave blank unless required" /></>}
                    <Field label="Temperature" value={draft.temperature} onChange={v => field('temperature', v)} inputMode="decimal" placeholder="Provider default" />
                    <label className="block space-y-1"><span>Reasoning / thinking level</span><select className={inputClass} value={draft.reasoningEffort} onChange={e => field('reasoningEffort', e.target.value)}>
                      <option value="">Provider default</option>{efforts.map(level => <option key={level} value={level}>{level}</option>)}
                    </select></label>
                    {(draft.format === 'anthropic' || draft.format === 'gemini') && <Field label="Thinking budget (tokens)" value={draft.thinkingBudget} onChange={v => field('thinkingBudget', v)} inputMode="numeric" placeholder="Optional alternative to thinking level" />}
                    {draft.format === 'anthropic' && <Field label="Anthropic API version" value={draft.apiVersion} onChange={v => field('apiVersion', v)} placeholder="2023-06-01" />}
                    {draft.format === 'chat-completions' && <label className="block space-y-1"><span>Output token parameter</span><select className={inputClass} value={draft.maxTokenParameter} onChange={e => field('maxTokenParameter', e.target.value as LlmConfig['maxTokenParameter'])}>
                      <option value="max_tokens">max_tokens (most compatible APIs)</option><option value="max_completion_tokens">max_completion_tokens (OpenAI)</option>
                    </select></label>}
                  </div>
                  <p className="text-xs text-slate-400">Leave optional controls blank for provider defaults. Temperature and thinking options depend on the model. HTTP is supported for localhost servers.</p>
                  {!!editing?.headerNames.length && <p className="text-xs text-slate-400">Saved headers: {editing.headerNames.join(', ')}. Values stay hidden.</p>}
                  <label className="flex items-center gap-2"><input type="checkbox" checked={replaceHeaders} onChange={e => { setReplaceHeaders(e.target.checked); setMessage(''); }} />Set or replace custom headers</label>
                  {replaceHeaders && <label className="block space-y-1"><span>Custom headers (JSON)</span><textarea className={`${inputClass} font-mono text-xs`} rows={3} value={headers} onChange={e => { setHeaders(e.target.value); setMessage(''); }} spellCheck={false} placeholder={'{"x-custom-header":"value"}'} />
                    <span className="block text-xs text-slate-400">Values are saved securely. An empty object clears existing headers.</span></label>}
                  <label className="block space-y-1"><span>Additional request parameters (JSON)</span><textarea className={`${inputClass} font-mono text-xs`} rows={4} value={draft.extraBody} onChange={e => field('extraBody', e.target.value)} spellCheck={false} />
                    <span className="block text-xs text-slate-400">For options such as top_p or provider routing. Put secrets in the API-key or custom-header fields.</span></label>
                </div>
              </details>
              <label className="flex items-center gap-2"><input type="checkbox" checked={makeDefault} onChange={e => { setMakeDefault(e.target.checked); setMessage(''); }} />Make this the default</label>
              <p className="text-xs text-slate-400">The default is preselected for new strategy configurations. Existing selections stay as saved. Running strategies use their current configuration until restarted.</p>
            </div>
          </fieldset>
          {message && <p role="status" className={`rounded-lg border border-surface-border p-3 break-words ${success ? 'text-theme-secondary' : 'text-amber-300'}`}>{message}</p>}
          {running && <p className="text-xs text-amber-300">Stop this strategy before selecting a different configuration for it.</p>}
        </div>
        <div className="border-t border-surface-border px-5 py-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void test()}>{operation === 'test' ? 'Testing…' : 'Test connection'}</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void save()}>Save</button>
            {editing && <button type="button" className={buttonClass} disabled={busy} onClick={() => void save(true)}>Save as new</button>}
            <button type="button" className="btn-tactile rounded-lg bg-theme-primary px-3 py-2 font-semibold text-slate-950 disabled:opacity-50" disabled={busy || running} onClick={() => void save(false, true)}>Use for this strategy</button>
            {editing && <button type="button" className="ml-auto rounded px-2 py-2 text-slate-400 hover:text-red-400 disabled:opacity-50" disabled={busy} onClick={() => void remove()}>Delete</button>}
          </div>
          <p className="text-xs text-slate-500">Test connection sends a small sample image and checks JSON output. Your provider may charge for the request.</p>
        </div>
      </section>
    </div>
  </ModalDialog>;
}
