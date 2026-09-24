# DEKXDIS

DEKXDIS   - defi limit trading from your own computer.
Trade pretty much any ERC-20 token with Realtime charts from Tradingview.
Select a token or import your own from the drop-down window.  Imported contract addresses, run a GoPlus security scan, it gives you some information about the token, but you should always check out the token you want to trade yourself.  
To place a trade just right click the chart and it will give you a window with the price you clicked at, you can edit the price, the amount you want to trade, add a SL and/or TP OCO and it takes care of the rest.  Understand the Stop losses are not perfect in Defi, major dumps it will not protect you.  Besides you want to buy the dip not sell the dip. Just saying, oh and myself or DEKXDIS is not giving you any finical advice, anything you do or lose is your own decision.  Don’t be a dummy, only trade what you can afford to lose.

**Set Your Price. Capture the Surplus. Pay 0% in Flat DEKXDIS Fees.**

CoW Protocol also charges a small **0.02% volume fee for standard assets**. If no surplus is generated, that fee still applies. This has been rare in our own trading: only **two out of more than 1,000 trades** produced no surplus. Read on to understand how it works.

When you trade on our platform, you are always in complete control. You set the exact price you want for your tokens—your order will swap at that price, **and absolutely no less. But it can be more.**

Through our integration with [**CoW Protocol**](https://cow.fi/), we utilize an advanced network of independent "solvers" to match your orders. Instead of relying on a single liquidity pool, solvers tap into a vast web of secure sources—including on-chain pools, major exchanges, and private peer-to-peer sale orders—to find you the best possible rate.

The best part? **The solvers only get paid if they save you money by generating a surplus on your order.** This performance-driven structure guarantees that everyone's incentives are perfectly aligned.

**How it Works (The $100 Example)**

Imagine you want to sell Token A. You place an order intent stating you want to receive exactly **$100 USD** for your tokens.

1. **The Solver Auction:** Your order goes out to a competitive batch auction where solvers bid to find you the absolute highest return. Solver 1 finds a route for $101, Solver 2 finds one for $102... **Sold!**
2. **The Surplus:** They just secured an execution price that is **$2.00 more** than you were originally asking for. This $2.00 is your trade surplus.
3. **The Clear Payout Breakdown:**
   - **CoW Protocol Fee:** CoW Protocol charges 50% of the surplus (capped at 0.98% of total trade volume), plus a **0.02% volume fee** for standard assets. Together, these amount to approximately **$1.020** in this example.
   - **Dekxdis Fee:** Our platform takes a 25% performance cut of the surplus remaining after CoW Protocol fees (capped at 1% of trade volume), which amounts to approximately **$0.245**.
   - **Your Share:** You keep the remaining surplus after those capped fees. In this scenario, **you walk away with approximately $0.735 extra**, receiving **$100.74** after rounding.

You received exactly what you wanted for your tokens, all platform and protocol infrastructure costs were fully covered, and you walked away with extra money in your wallet. It is a true win-win for everyone.

**Why This Beats Traditional Exchanges**

- **No Artificial Markups:** Say goodbye to hidden fees, artificial spreads, and slippage nonsense.
- **Minimal Cost for Base Execution:** If the market doesn't allow solvers to find a surplus, CoW Protocol still charges its **0.02% volume fee** for standard assets—about **$0.02 on a $100 trade**. There is no surplus-based payout, and Dekxdis doesn't get anything. This has been rare in our own trading: only two out of more than 1,000 trades did not generate a surplus.
- **No Risk on Cancellations:** If you decide to cancel your order before it fills, you pay nothing.
- **Outperforming Centralized Exchanges (CEXs):** Traditional centralized platforms charge flat fees anywhere from **0.1% up to 2%** on your total order size. On a $100 trade, a standard exchange might swallow your funds in fees, leaving you with only **$98** for tokens you wanted $100 for. In this example, on our platform you leave with **$100.74**.

Ready to see how intent-based trading protects your capital? **Explore CoW Protocol here** to learn more about the underlying architecture, or **download the Dekxdis software** to start trading for free today.

The entire program runs on your own computer, all trades are signed by a wallet that DEKXDIS will create for you, or you can import your own ERC-20 wallet yourself.  Your key stays on your machine only, trades are signed on your computer and then sent to the CoW api. No websites, no middleman servers.  Your wallet stays with you, and your keys are stored in the windows encrypted storage on your computer.  

The DEKXDIS software gives you a workspace for every token you want to trade, each workspace contains a chart, A trades window that tracks pending transactions, filled transactions, and cancel transactions, with fill price, timestamped.   You get a wallet dedicated on the page for the token workspace your on, that shows the balance of the token and the overall native wrapped token it trades with.  Everything is shown in USD for convenience but traded in wrapped native tokens to avoid multiple trades and saves you fees. There is also a manual swap to USDT for those down times.  You can view and place trades for different tokens its workspace page, and if you switch pages your trades are managed in the background and always running even if you switch to view a different token.

This software is to make your trading easier with the lowest fees around; you can and will lose money trading.   The program is free to use, and the source code is on github.  You can build the program yourself and you can download the executable from the releases.  dekxdis.com is our website and has links to github and documents from there.  
Experimental workspace automation uses saved prompts and settings for each token. It sends the model a fresh chart and trade snapshot, then places the requested buys or sells through the same order path as the manual chart form. TP and SL are optional. Buys use your configured trade amount; strategy sells use the actual tokens remaining from a bought position. Unsold-buy counts, per-token USD allowances and the last model response are visible in the Automation window. See [the user guide](docs/dekxdis-user-guide.html#automation) for setup and behavior.

dekxdis.com
DEKXDIS@purelymail.com


## Get started

Download the Windows executable from [GitHub Releases](https://github.com/DEKXDIS/DEKXDIS/releases), run it, and follow the wallet setup. Keep your wallet backup safe. The [illustrated user guide](https://dekxdis.com/user-guide.html) explains each control; an offline copy is in `docs/dekxdis-user-guide.html`. Also can be view in the program selected in the top bar.  

## Build on Windows

Install Node.js 22 or later, Rust 1.88 or later with the MSVC toolchain, Visual Studio Build Tools with Desktop development with C++, and Microsoft Edge WebView2 Runtime.

```powershell
npm ci
npm run tauri:build
```

The executable is created at `src-tauri/target/release/DEKXDIS.exe`.

When you first run and after you create or import your wallet,  press the Overview button at the top to go the workspace page.  select it again goes back to the overview page.  
