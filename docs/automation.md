# Workspace automation

The installable strategy system has been removed: no module host, JavaScript runtime, package registry, scheduler, capability dispatcher, effect history or separate strategy order ledger remains.

Each token workspace has a prompt and settings in its Automation window. Start enables that token until Stop, wallet change, or application exit. Switching tokens and closing the Automation window leave enabled tokens running. Restarting the application leaves automation stopped. A model ID and a newly entered OpenAI API key are required; no old strategy state or credentials are imported.

## One decision

1. Capture the visible chart. For a background workspace, briefly mount the same `TradingViewChart` component with that workspace's saved interval, indicators, size and visible range, fetch fresh candles, capture, then unmount it. An unavailable chart produces an error rather than a data-only substitute.
2. Assemble the chart image, token identity, current local orders, positions derived from confirmed fills, bounded recent history and freshly queried balances. Cleared display history remains available through the main application's accounting archive. Pending buys count toward the configured maximum; filled buys, TP orders and SL orders do not.
3. Send one OpenAI Responses request with the user's prompt and the response format shown in the window. There is no conversation ID, prior response chain or stored transcript. The request sets `store: false`.
4. Display the response, then parse it before placing anything. Accept buys, limit sells and conditional stop sells, with individually optional TP/SL. Apply the user's fixed amount or accept model-selected amounts. Recheck current wallet, open-buy count, timing, per-token trading allowance and available wallet funds during placement.
5. Call `placeOrder`, the same function used by `LimitOrderModal`. Convert USD display amounts/prices into exact token quantities, authorize, sign, save the actual order identity, and submit through the existing CoW client. The main execution engine continues managing fills, protection, OCO and recovery of uncertain submissions.
6. Discard the image and input packet. Replace the token's single saved response text and timestamp, keep the short progress status in memory, and schedule the next check. Progress and placement errors do not replace the displayed response. No response history accumulates. Actual trades remain in the main order history.

Stops invalidate pending decisions. An order already handed to the main execution engine remains that engine's responsibility. Stopping automation does not cancel placed orders.

## Trading allowance and entry prices

Each token has an independent USD allowance; blank means unlimited and zero prevents automation buys. The wallet balance is not divided among tokens. Every buy still requires enough unreserved wrapped native tokens in the actual wallet.

Allowance usage is derived from that wallet, chain and token's main accounting history, including manual trades. Confirmed buy costs consume it; confirmed sell proceeds restore it up to the configured limit. Pending buys reserve their unfilled amount, and cancelling them releases that reservation. Unfilled sells and TP/SL triggers provide no credit. For example, a $100 limit, $60 spent, $40 returned from sales and $10 in pending buys leaves $70 available. Losses reduce the funds available to trade; profits do not raise the configured ceiling. Stopping, restarting and clearing display history do not reset usage. Missing fill amounts or USD conversions are shown as unavailable and must resolve before another limited automation buy can proceed. No separate allowance ledger is stored.

The disposable packet distinguishes requested limit prices from actual average fill prices, and includes each remaining position's entry price and the quantity-weighted average cost of remaining tokens. USD fill prices use the main application's conversion recorded during reconciliation, not a historical settlement-time oracle. Missing prices are null. A prompt can use these fields to request a minimum selling margin; there is no program-enforced minimum-profit rule.

## Storage boundary

- Small prompt/settings and chart-view records use new browser storage keys scoped by wallet, chain and token.
- One latest-response text record per wallet, chain and token stays visible across window reopening and application restarts until a new response arrives. It is not sent back to the model as conversation history.
- The API key uses its own Windows-encrypted `automation-openai.dpapi` file. It is never passed to JavaScript.
- Existing wallet files and their identity/serialization fields are preserved. Startup reads existing wallet files without rewriting them to migrate strategy data.
- On the first launch of this replacement, an explicit one-time cleanup removes old module records, old ladder settings, order history/accounting history, submissions and order markers from the non-secret application data. This clean start was requested for this replacement. Subsequent launches retain new orders normally.
- There is no funded/live test or performance baseline in the validation. The checks use mocked trading/model boundaries and sample chart data.

## Main files

`src/automation/AutomationWindow.tsx` — themed form, allowance and latest response display.

`src/automation/runner.ts` — per-workspace lifecycle and policy checks.

`src/automation/chartCapture.tsx` and `chartRegistry.ts` — visible or temporary background chart capture.

`src/automation/packet.ts` — disposable trade snapshot and response parser.

`src/automation/allowance.ts` — allowance derived from main order records and buy checks.

`src/automation/latestResponse.ts` — single saved response text per workspace.

`src/services/orderPlacement.ts` — shared manual/automation placement.

`src-tauri/src/automation.rs` — isolated API-key storage and one-shot model request.

`scripts/check-automation.mjs` — focused offline regression checks.
