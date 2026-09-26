# DEKXDIS

DEKXDIS   - defi limit trading from your own computer, and why not we threw in a LLM Based trading bot that you tell it do what you want. 
Works with CoW solvers to complete trades for better than what you ask for, covering your fees, and giving you extra tokens on 98% of your trades  (98% is a number to represent how often you generate a surplus, but it is not excatly 98, it could be 97.7, or 99.1.)

Easy to use, just click the chart and it will let you place an order at that spot, it will also put a tp, or sl if want on the order that will place an OCO order when your buy fills. Shows you where right on the chart.  

every token has its own workspace, with information, orders, history, and automation that is separate from other workspaces.  you can run 2 or you can run 50, or more all working at the same time. view one workspace, switch to another, they keep running.  keeps the clutter down.  each workspace can be setup with the same llm and settings, prompt, or you can have each one using different llm's or prompts.  They all have limits that can be set in th ui, to keep your llm in check. All you need to do is tell how you want it to act. It is sent a package with the chart for the token workspace you are on, history of trades, and your limits you have set.  tell it to trade the support and resistance levels, or where you want it place trades at.  tell it to include a tp and or a sl, or neither. it is only given the package of data, and that is all.  Their is more info in the user guide, you can find on the website or through the program.

The program is run on your own computer, all trades are signed on your pc and your keys stay there, no shady website to add your wallet too.  everything stays in your control.  data comes from public api's that you connect directly to, no middle man.  LLM uses your own api keys and goes directly to their servers, no middle man.  keep everything running safe and sound at home. Just keep the app running, or it does not work very good. 

I have been working on this for the better part of a year, some was llm coded, but it is not something wiped up in a few nights, it has been tested and running on a few dozen pcs currently and I personally use it to trade. That was the whole idea, I wanted something that I could just click on a chart, and it placed a trade for me. easy. Added more features and after yelling at basically ever llm out there, and threatening to remove it from existence, after it has told me how many smoke test it passed, we have arrived here, the easiest and cheapest way to trade possible.  If you have not looked up Cow protocol for trading, give it a read, it's a great idea, where everyone gets paid and not at the expense of your funds.  

Their will be updates, as we progress, open a issue if you have an idea, or find a bug, ill do my best to get to it, I am just one person, and have other life things going on, so if i am slow to responde, just be paitent please. 
yes there is an android app coming and a linux version very soon.  right now it is only for windows.  


**Set Your Price. Capture the Surplus. Pay 0% in Flat DEKXDIS Fees.**


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
- **Minimal Cost for Base Execution:** If the market doesn't allow solvers to find a surplus, CoW Protocol charges a tiny fee of **0.02% volume fee** which they need to cover cost to them. which is **$0.02 on a $100 trade**. Compared to exchanges or other wallet apps, this is very low. Besides this has been rare in our own trading: only two out of more than 3,000 trades did not generate a surplus. 
- **No Risk on Cancellations:** If you decide to cancel your order before it fills, you pay nothing.
- **Outperforming Centralized Exchanges (CEXs):** Traditional centralized platforms charge flat fees anywhere from **0.1% up to 2%** on your total order size. On a $100 trade, a standard exchange might swallow your funds in fees, leaving you with only **$98** for tokens you wanted $100 for. In this example, on our platform you leave with **$100.74**.

Ready to see how intent-based trading protects your capital? **Explore CoW Protocol here** [**CoW Protocol**](https://cow.fi/) to learn more about the underlying architecture, or **download the Dekxdis software** to start trading for basically free today.

The entire program runs on your own computer, all trades are signed by a wallet that DEKXDIS will create for you, or you can import your own ERC-20 wallet yourself.  Your key stays on your machine only, trades are signed on your computer and then sent to the CoW api. No websites, no middleman servers.  Your wallet stays with you, and your keys are stored in the windows encrypted storage on your computer.  

The DEKXDIS software gives you a workspace for every token you want to trade, each workspace contains a chart, A trades window that tracks pending transactions, filled transactions, and cancel transactions, with fill price, timestamped.   You get a wallet dedicated on the page for the token workspace your on, that shows the balance of the token and the overall native wrapped token it trades with.  Everything is shown in USD for convenience but traded in wrapped native tokens to avoid multiple trades and saves you fees. There is also a manual swap to USDT for those down times.  You can view and place trades for different tokens its workspace page, and if you switch pages your trades are managed in the background and always running even if you switch to view a different token.

This software is to make your trading easier with the lowest fees around; you can and will lose money trading.   The program is free to use, and the source code is on github.  You can build the program yourself or you can download the executable from the releases.  dekxdis.com is our website and has links to github and documents from there.  
Experimental workspace automation uses saved prompts and settings for each token. It sends the model a fresh chart and trade snapshot, then places the requested buys or sells through the same order path as the manual chart form. TP and SL are optional. Buys use your configured trade amount; strategy sells use the actual tokens remaining from a bought position. Unsold-buy counts, per-token USD allowances and the last model response are visible in the Automation window. See [the user guide](https://dekxdis.com/user-guide.html#automation) for setup and behavior.

dekxdis.com
DEKXDIS@purelymail.com


## Get started

Download the Windows executable from [GitHub Releases](https://github.com/DEKXDIS/DEKXDIS/releases), run it, and follow the wallet setup. Keep your wallet backup safe. The [illustrated user guide](https://dekxdis.com/user-guide.html) explains each control and can also be opened from the program's top bar.

## Build on Windows

Install Node.js 22 or later, Rust 1.88 or later with the MSVC toolchain, Visual Studio Build Tools with Desktop development with C++, and Microsoft Edge WebView2 Runtime.

```powershell
npm ci
npm run tauri:build
```

The executable is created at `src-tauri/target/release/DEKXDIS.exe`.

When you first run and after you create or import your wallet,  press the Overview button at the top to go the workspace page.  select it again goes back to the overview page.  read the user document on how to use the program.  


Use this at your own risk, private keys, and other api keys are stored in windows safe storage and never leave your machine.  The LLM will only trade how you tell it to trade, their is built in safe gaurds, but nothing is perfect. make sure you read the documents and start with small trades to get comfortable, this is real money and real trades, there is no backtesting or dry runs. They just lead to false hopes and dreams, and if your not willing to risk a few dollars, then you should not be trading, and should find something more to your style.  Not trying to be rude, just real.  
