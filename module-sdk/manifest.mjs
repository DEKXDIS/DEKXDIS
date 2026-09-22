import { exactKeys } from './package.mjs';

export const HOST_VERSION = '1.3.2';
export const CAPABILITIES = Object.freeze(['market.price.v1', 'market.candles.v1', 'chart.snapshot.v1', 'events.schedule.v1', 'state.module.v1', 'http.request.v1', 'secrets.inject.v1', 'orders.limit-entry.v1', 'orders.limit-exit.v1', 'orders.protection.v1', 'orders.observe.v1', 'orders.cancel.v1', 'orders.funding.v1', 'ui.module.v1', 'log.module.v1', 'llm.ask.v1']);
export const TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '1h', '4h', '1d']);
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const text = (value, limit, label) => ensure(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value), `${label} must be nonempty text, at most ${limit} UTF-8 bytes`);
const list = (value, max, label) => ensure(Array.isArray(value) && value.length <= max, `${label} must be an array, at most ${max} entries`);
const identifier = (value, label) => ensure(typeof value === 'string' && ID.test(value), `Invalid ${label}`);
const unique = (values, label) => ensure(new Set(values).size === values.length, `Duplicate ${label}`);
const allowedKeys = (object, required, optional, label) => {
  ensure(object && typeof object === 'object' && !Array.isArray(object), `${label} must be an object`);
  ensure(required.every(key => Object.hasOwn(object, key)) && Object.keys(object).every(key => [...required, ...optional].includes(key)), `${label} has missing or unsupported fields`);
};
const integer = (value, min, max, label) => ensure(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be ${min}–${max}`);
const version = (value, label) => ensure(typeof value === 'string' && SEMVER.test(value) && value.split('.').every(n => Number.isSafeInteger(Number(n))), `Invalid ${label}; use major.minor.patch`);
function compareVersions(a, b) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }

export function validateManifest(manifest, { hostVersion = HOST_VERSION } = {}) {
  allowedKeys(manifest, ['moduleId', 'moduleVersion', 'name', 'description', 'hostApiVersion', 'minimumHostVersion', 'requestedCapabilities', 'supportedChains', 'configurationSchema', 'secretSlots', 'viewSchema', 'endpointDeclarations', 'resourceRequirements'], ['tradeCountControl', 'orderAmountControl', 'eventSubscriptions', 'stateSchemaVersion', 'decisionIntervalMs'], 'Manifest');
  ensure(manifest.tradeCountControl === undefined || manifest.tradeCountControl === 'module', 'Invalid trade count control');
  ensure(manifest.orderAmountControl === undefined || manifest.orderAmountControl === 'module', 'Invalid order amount control');
  ensure(typeof manifest.moduleId === 'string' && /^[a-z][a-z0-9.-]{2,63}$/.test(manifest.moduleId) && !manifest.moduleId.includes('..'), 'Invalid module ID');
  version(manifest.moduleVersion, 'module version'); version(manifest.minimumHostVersion, 'minimum host version');
  ensure(manifest.hostApiVersion === 1 || manifest.hostApiVersion === 2, 'Unsupported host API version');
  ensure(compareVersions(manifest.minimumHostVersion, hostVersion) <= 0, `Module requires DEKXDIS ${manifest.minimumHostVersion}`);
  text(manifest.name, 100, 'Module name'); text(manifest.description, 1000, 'Module description');
  list(manifest.requestedCapabilities, CAPABILITIES.length, 'Capabilities'); unique(manifest.requestedCapabilities, 'capability');
  for (const capability of manifest.requestedCapabilities) ensure(CAPABILITIES.includes(capability), `Unsupported capability: ${capability}`);
  const has = capability => manifest.requestedCapabilities.includes(capability);
  list(manifest.supportedChains, 16, 'Chains'); ensure(manifest.supportedChains.length > 0, 'A supported chain is required'); unique(manifest.supportedChains, 'chain');
  for (const chain of manifest.supportedChains) ensure([1, 56, 100, 137, 42161, 8453, 43114, 10].includes(chain), `Unsupported chain: ${chain}`);
  list(manifest.configurationSchema, 32, 'Configuration fields'); unique(manifest.configurationSchema.map(field => field.key), 'configuration key');
  for (const field of manifest.configurationSchema) {
    allowedKeys(field, ['key', 'label', 'type', 'default'], ['required', 'min', 'max', 'maxLength', 'options', 'description', 'group', 'lines'], 'Configuration field');
    identifier(field.key, 'configuration key'); text(field.label, 120, 'Field label');
    ensure(['string', 'number', 'boolean', 'select'].includes(field.type), 'Unsupported configuration control');
    if (field.required !== undefined) ensure(typeof field.required === 'boolean', 'required must be boolean');
    if (field.description !== undefined) text(field.description, 500, 'Field description');
    if (field.group !== undefined) text(field.group, 100, 'Field group');
    if (field.lines !== undefined) integer(field.lines, 2, 40, 'Field lines');
    if (field.maxLength !== undefined) integer(field.maxLength, 1, 2048, 'Field length');
    if (field.min !== undefined) ensure(typeof field.min === 'number' && Number.isFinite(field.min), 'Invalid minimum');
    if (field.max !== undefined) ensure(typeof field.max === 'number' && Number.isFinite(field.max), 'Invalid maximum');
    ensure(field.min === undefined || field.max === undefined || field.min <= field.max, 'Field minimum exceeds maximum');
    if (field.type === 'boolean') ensure(typeof field.default === 'boolean', 'Boolean default required');
    else if (field.type === 'number') ensure((typeof field.default === 'number' && Number.isFinite(field.default)) || (typeof field.default === 'string' && (field.default === '' || Number.isFinite(Number(field.default)))), 'Number default required');
    else ensure(typeof field.default === 'string' && Buffer.byteLength(field.default, 'utf8') <= (field.maxLength ?? 2048), 'String default required');
    if (field.type === 'select') {
      list(field.options, 32, 'Select options'); ensure(field.options.length > 0, 'Select options required'); unique(field.options.map(option => option.value), 'select option');
      for (const option of field.options) { exactKeys(option, ['label', 'value'], 'Select option'); text(option.label, 120, 'Option label'); text(option.value, 256, 'Option value'); }
      ensure(field.options.some(option => option.value === field.default), 'Default must be a declared option');
    } else ensure(field.options === undefined, 'Only select fields accept options');
  }
  list(manifest.secretSlots, 16, 'Secret slots'); unique(manifest.secretSlots.map(slot => slot.id), 'secret slot');
  for (const slot of manifest.secretSlots) { exactKeys(slot, ['id', 'label', 'required'], 'Secret slot'); identifier(slot.id, 'secret slot'); text(slot.label, 120, 'Secret label'); ensure(typeof slot.required === 'boolean', 'Secret required must be boolean'); }
  ensure(!manifest.secretSlots.length || has('secrets.inject.v1'), 'Secret slots require secrets.inject.v1');
  exactKeys(manifest.viewSchema, ['fields', 'buttons'], 'View schema'); list(manifest.viewSchema.fields, 32, 'View fields'); list(manifest.viewSchema.buttons, 16, 'View buttons');
  unique(manifest.viewSchema.fields.map(field => field.key), 'view key'); unique(manifest.viewSchema.buttons.map(button => button.id), 'button ID');
  for (const field of manifest.viewSchema.fields) { exactKeys(field, ['key', 'label', 'type'], 'View field'); identifier(field.key, 'view key'); text(field.label, 120, 'View label'); ensure(['text', 'number', 'image', 'table'].includes(field.type), 'Unsupported view field'); }
  for (const button of manifest.viewSchema.buttons) { exactKeys(button, ['id', 'label'], 'View button'); identifier(button.id, 'button ID'); text(button.label, 120, 'Button label'); }
  ensure(!(manifest.viewSchema.fields.length || manifest.viewSchema.buttons.length) || has('ui.module.v1'), 'Views require ui.module.v1');
  list(manifest.endpointDeclarations, 16, 'Endpoints'); unique(manifest.endpointDeclarations.map(endpoint => endpoint.id), 'endpoint ID');
  ensure(!manifest.endpointDeclarations.length || has('http.request.v1'), 'Endpoints require http.request.v1');
  for (const endpoint of manifest.endpointDeclarations) {
    allowedKeys(endpoint, ['id', 'origin', 'path', 'method'], ['authentication'], 'Endpoint'); identifier(endpoint.id, 'endpoint ID');
    const url = new URL(endpoint.origin);
    ensure(url.protocol === 'https:' && url.origin === endpoint.origin && !url.port && !url.username && !url.password && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) && url.hostname.includes('.') && !/^\d+(?:\.\d+){3}$/.test(url.hostname) && !/(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname), 'Endpoint must declare a public HTTPS origin on port 443');
    ensure(typeof endpoint.path === 'string' && /^\/(?!\/)/.test(endpoint.path) && endpoint.path.length <= 1024 && !/[?#%\\\s]/.test(endpoint.path) && !endpoint.path.split('/').some(part => ['.', '..'].includes(part)), 'Endpoint must declare an exact absolute path');
    ensure(endpoint.method === 'GET' || endpoint.method === 'POST', 'Endpoint method must be GET or POST');
    if (endpoint.authentication) {
      const auth = endpoint.authentication; allowedKeys(auth, ['slotId', 'placement', 'name'], ['prefix'], 'Authentication');
      ensure(manifest.secretSlots.some(slot => slot.id === auth.slotId), 'Authentication slot is not declared');
      ensure(auth.placement === 'header' || auth.placement === 'body', 'Unsupported authentication placement');
      ensure(typeof auth.name === 'string' && (auth.placement === 'header' ? /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(auth.name) : /^(?:\/(?:[^~\/]|~[01])+)+$/.test(auth.name) && auth.name.length <= 256), 'Invalid authentication header or JSON pointer');
      ensure(auth.placement !== 'body' || endpoint.method === 'POST', 'Body authentication requires POST');
      if (auth.prefix !== undefined) ensure(typeof auth.prefix === 'string' && Buffer.byteLength(auth.prefix, 'utf8') <= 64 && !/[\r\n\x00]/.test(auth.prefix), 'Invalid authentication prefix');
    }
  }
  if (manifest.hostApiVersion === 2) {
    ensure(manifest.eventSubscriptions === undefined && manifest.stateSchemaVersion === undefined, 'An ABI v2 module declares decisionIntervalMs, not events or state');
    integer(manifest.decisionIntervalMs, 6000, 86400000, 'Decision interval');
    ensure(!has('llm.ask.v1') || manifest.endpointDeclarations.some(endpoint => endpoint.id === 'vision'), 'Analysis requires a "vision" endpoint declaration');
    ensure(!has('llm.ask.v1') || manifest.configurationSchema.some(field => field.key === 'model'), 'Analysis requires a "model" setting');
    integer(manifest.resourceRequirements?.memoryMb ?? 0, 1, 32, 'Memory MB');
    return manifest;
  }
  ensure(manifest.decisionIntervalMs === undefined, 'decisionIntervalMs requires host API version 2');
  ensure(manifest.eventSubscriptions !== undefined && manifest.stateSchemaVersion !== undefined, 'An ABI v1 module must declare events and a state schema');
  list(manifest.eventSubscriptions, 16, 'Subscriptions'); unique(manifest.eventSubscriptions.map(subscription => JSON.stringify(subscription)), 'subscription');
  for (const subscription of manifest.eventSubscriptions) {
    if (subscription.type === 'timer' || subscription.type === 'price') {
      exactKeys(subscription, ['type', 'intervalMs'], 'Subscription'); integer(subscription.intervalMs, 6000, 86400000, 'Subscription interval');
      ensure(has('events.schedule.v1'), 'Scheduling requires events.schedule.v1');
      if (subscription.type === 'price') ensure(has('market.price.v1'), 'Price subscription requires market.price.v1');
    } else if (subscription.type === 'candle-close') {
      exactKeys(subscription, ['type', 'timeframe'], 'Subscription'); ensure(TIMEFRAMES.includes(subscription.timeframe), 'Unsupported candle timeframe'); ensure(has('events.schedule.v1') && has('market.candles.v1'), 'Candle subscription requires schedule and candles capabilities');
    } else if (subscription.type === 'order') { exactKeys(subscription, ['type'], 'Subscription'); ensure(has('orders.observe.v1'), 'Order events require orders.observe.v1'); }
    else throw new Error('Unsupported subscription');
  }
  integer(manifest.stateSchemaVersion, 1, 1000000, 'State schema version');
  exactKeys(manifest.resourceRequirements, ['memoryMb', 'cpuMs', 'maxStateBytes'], 'Resource requirements');
  integer(manifest.resourceRequirements.memoryMb, 1, 32, 'Memory MB'); integer(manifest.resourceRequirements.cpuMs, 1, 250, 'CPU milliseconds'); integer(manifest.resourceRequirements.maxStateBytes, 1, 256 * 1024, 'State bytes');
  return manifest;
}
