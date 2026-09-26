import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LlmConfigurationModal } from '../src/automation/LlmConfigurationModal';
import { credentialScope, emptyProfiles, type LlmProfileInput, type LlmProfiles } from '../src/automation/llmProfiles';

// Native boundary fixture; all data is synthetic and nothing is written to the user's vault.
let database: LlmProfiles = structuredClone(emptyProfiles);
let count = 0;
const calls: { name: string; input: LlmProfileInput }[] = [];
(globalThis as any).__llmInvoke = async (name: string, args: any) => {
  const input: LlmProfileInput = args.input;
  calls.push({ name, input });
  if (name === 'automation_profile_test') return 'Connection, image input and JSON response verified';
  if (name === 'automation_profile_delete') { database.profiles = database.profiles.filter(p => p.id !== args.id); return structuredClone(database); }
  if (name !== 'automation_profile_save') throw new Error('Unexpected command: ' + name);
  const id = input.saveAsNew || !input.id ? `fixture-${++count}` : input.id;
  const existing = database.profiles.find(p => p.id === input.id);
  const credentialId = input.newKey ? `key-${count}` : input.credentialId;
  if (input.newKey) database.credentials.push({ id: credentialId!, label: 'Fixture saved key', scope: credentialScope(input.config)! });
  const saved = { id, config: structuredClone(input.config), revision: (existing?.revision || 0) + 1,
    credentialId, headerNames: input.headers ? Object.keys(input.headers) : existing?.headerNames || [], ready: !!credentialId || input.config.authMode === 'none' };
  database.profiles = [...database.profiles.filter(p => p.id !== id), saved];
  if (input.makeDefault) database.defaultProfileId = id;
  else if (database.defaultProfileId === id) database.defaultProfileId = null;
  return { id, list: structuredClone(database) };
};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const root = createRoot(document.getElementById('root')!);
function Harness() {
  const [profiles, setProfiles] = useState<LlmProfiles>(emptyProfiles);
  const [selected, setSelected] = useState('');
  const [open, setOpen] = useState(true);
  return <div className="p-6 text-slate-200"><p>Selected profile: <span id="selected">{selected}</span></p>
    <button onClick={() => setOpen(true)}>Configure LLM</button>
    {open && <LlmConfigurationModal profiles={profiles} selectedId={selected} running={false} onProfilesChange={setProfiles}
      onUse={profile => setSelected(profile.id)} onClose={() => setOpen(false)} />}</div>;
}
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
function control(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const element = [...document.querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === label);
  const input = element?.querySelector('input,select,textarea');
  assert(input, 'Missing control: ' + label); return input as any;
}
async function change(label: string, value: string) {
  const element = control(label);
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
async function click(text: string) {
  const element = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  assert(element, 'Missing button: ' + text); await act(async () => element!.click());
}
const results = document.getElementById('results')!;
try {
  await act(async () => root.render(<Harness />));
  await change('Preconfigured model', 'Anthropic:claude-sonnet-5');
  assert(control('Server / base URL').value === 'https://api.anthropic.com', 'Preset did not fill endpoint');
  await change('Configuration name', 'Claude — chart analysis');
  await change('API key', 'synthetic-key-only');
  const defaultBox = [...document.querySelectorAll('label')].find(l => l.textContent?.trim() === 'Make this the default')?.querySelector('input');
  await act(async () => defaultBox!.click());
  await click('Save');
  assert(database.defaultProfileId === 'fixture-1', 'Default not saved');
  assert(control('Replacement API key (optional)').value === '', 'Key was not cleared after saving');
  assert(document.getElementById('selected')?.textContent === '', 'Saving implicitly assigned a strategy');
  await click('Use for this strategy');
  assert(!document.querySelector('dialog'), 'Use did not close the dialog');
  assert(document.getElementById('selected')?.textContent === 'fixture-1', 'Use did not assign the profile');
  await click('Configure LLM');
  assert(control('Configuration name').value === 'Claude — chart analysis', 'Saved profile did not reopen');
  await change('Configuration name', 'Claude — faster checks');
  await click('Save as new');
  assert(database.profiles.length === 2, 'Save as new replaced original');
  assert(database.profiles[0].config.name === 'Claude — chart analysis', 'Original profile changed');
  assert(database.profiles[1].credentialId === database.profiles[0].credentialId, 'Saved key not reused');
  await change('Preconfigured model', '');
  await change('Configuration name', 'Local vision model');
  await change('Server / base URL', 'http://localhost:1234');
  await change('Model ID', 'local-vision');
  const details = document.querySelector('details')!; details.open = true;
  await change('Authentication', 'none');
  await click('Test connection');
  assert(calls.at(-1)?.name === 'automation_profile_test', 'Test did not use its own native command');
  assert(calls.at(-1)?.input.config.authMode === 'none', 'Local authentication not preserved');
  await click('Save');
  assert(database.profiles.length === 3, 'Custom profile not saved');
  await change('Saved configurations', 'fixture-1');
  assert(control('Model ID').value === 'claude-sonnet-5', 'Saved profile selection lost model');
  results.textContent = 'PASS: preset filling, default checkbox, key clearing, Save, Use, reopen, Save as new, key reuse, custom local configuration, and connection-test command.';
  results.dataset.result = 'pass';
} catch (error) {
  results.textContent = 'FAIL: ' + String(error); results.dataset.result = 'fail';
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
