# Workspace automation

The installable strategy system has been removed: no module host, JavaScript runtime, package registry, scheduler, capability dispatcher, effect history or separate strategy order ledger remains.

Each token workspace has a prompt and settings in its Automation window. Start enables that token until Stop, wallet change, or application exit. Switching tokens and closing the Automation window leave enabled tokens running. Restarting the application leaves automation stopped. A model ID and a newly entered OpenAI API key are required; no old strategy state or credentials are imported.

## One decision

1. Capture the visible chart. For a background workspace, briefly mount the same `TradingViewChart` component with that workspace's saved interval, indicators, size and visible range, fetch fresh candles, capture, then unmount it. An unavailable chart produces an error rather than a data-only substitute.
2. Assemble the chart image, token identity, current local orders, positions derived from confirmed fills, bounded recent history and freshly queried balances. Cleared display history remains available through the main application's accounting archive. Pending buys count toward the configured maximum; filled buys, TP orders and SL orders do not.
3. Send one OpenAI Responses request with the user's prompt and the response format shown in the window. There is no conversation ID, prior response chain or stored transcript. The request sets `store: false`.
4. Parse the response before placing anything. Accept buys, limit sells and conditional stop sells, with individually optional TP/SL. Apply the user's fixed amount or accept model-selected amounts. Recheck current wallet, open-buy count, timing and available funds during placement.
5. Call `placeOrder`, the same function used by `LimitOrderModal`. Convert USD display amounts/prices into exact token quantities, authorize, sign, save the actual order identity, and submit through the existing CoW client. The main execution engine continues managing fills, protection, OCO and recovery of uncertain submissions.
6. Discard the image, packet and full response. Keep only the latest short status in memory and schedule the next check. A no-trade cycle writes no strategy state. Actual trades remain in the main order history.

Stops invalidate pending decisions. An order already handed to the main execution engine remains that engine's responsibility. Stopping automation does not cancel placed orders.

## Storage boundary

- Small prompt/settings and chart-view records use new browser storage keys scoped by wallet, chain and token.
- The API key uses its own Windows-encrypted `automation-openai.dpapi` file. It is never passed to JavaScript.
- Existing wallet files and their identity/serialization fields are preserved. Startup reads existing wallet files without rewriting them to migrate strategy data.
- On the first launch of this replacement, an explicit one-time cleanup removes old module records, old ladder settings, order history/accounting history, submissions and order markers from the non-secret application data. This clean start was requested for this replacement. Subsequent launches retain new orders normally.
- There is no funded/live test or performance baseline in the validation. The checks use mocked trading/model boundaries and sample chart data.

## Main files

`src/automation/AutomationWindow.tsx` — form and latest status.

`src/automation/runner.ts` — per-workspace lifecycle and policy checks.

`src/automation/chartCapture.tsx` and `chartRegistry.ts` — visible or temporary background chart capture.

`src/automation/packet.ts` — disposable trade snapshot and response parser.

`src/services/orderPlacement.ts` — shared manual/automation placement.

`src-tauri/src/automation.rs` — isolated API-key storage and one-shot model request.

`scripts/check-automation.mjs` — focused offline regression checks.
