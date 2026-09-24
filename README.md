# DEKXDIS

DEKXDIS   - defi limit trading from your own computer.
Trade pretty much any ERC-20 token with Realtime charts from Tradingview.
Select a token or import your own from the drop-down window.  Imported contract addresses, run a GoPlus security scan, it gives you some information about the token, but you should always check out the token you want to trade yourself.  
To place a trade just right click the chart and it will give you a window with the price you clicked at, you can edit the price, the amount you want to trade, add a SL and/or TP OCO and it takes care of the rest.  Understand the Stop losses are not perfect in Defi, major dumps it will not protect you.  Besides you want to buy the dip not sell the dip. Just saying, oh and myself or DEKXDIS is not giving you any finical advice, anything you do or lose is your own decision.  Don’t be a dummy, only trade what you can afford to lose.
Trades are handled by CoW protocol which completes your order at or better than the price you want and never less.  it includes gas in the trade by getting a better price for you and subtracts the gas from the surplus.  Fees are 0.07%, no hidden fees, no slippage, no mark up.  That is not a typo it really is 0.07% per trade.  Read up about CoW and the whole intents and solvers game if you haven’t already. It solves the MEV Problem.  CoW solvers make money only if they get you a better price for your trade and they take a cut of that surplus and you get the rest as a bonus. The 0.07% is split 0.05% to DEKXDIS and 0.02% to the CoW Protocol and that is the only fees that come off your trade amount.  If your order gets canceled for whatever reason, you pay nothing.  

The entire program runs on your own computer, all trades are signed by a wallet that DEKXDIS will create for you, or you can import your own ERC-20 wallet yourself.  Your key stays on your machine only, trades are signed on your computer and then sent to the CoW api. No websites, no middleman servers.  Your wallet stays with you, and your keys are stored in the windows encrypted storage on your computer.  

The DEKXDIS software gives you a workspace for every token you want to trade, each workspace contains a chart, A trades window that tracks pending transactions, filled transactions, and cancel transactions, with fill price, timestamped.   You get a wallet dedicated on the page for the token workspace your on, that shows the balance of the token and the overall native wrapped token it trades with.  Everything is shown in USD for convenience but traded in wrapped native tokens to avoid multiple trades and saves you fees. There is also a manual swap to USDT for those down times.  You can view and place trades for different tokens its workspace page, and if you switch pages your trades are managed in the background and always running even if you switch to view a different token.

This software is to make your trading easier with the lowest fees around; you can and will lose money trading.   The program is free to use, and the source code is on github.  You can build the program yourself and you can download the executable from the releases.  dekxdis.com is our website and has links to github and documents from there.  
Experimental workspace automation uses saved prompts and settings for each token. It sends the model a fresh chart and trade snapshot, then places the requested buys or sells through the same order path as the manual chart form. TP and SL are optional. See [the automation notes](docs/automation.md) for setup and behavior.

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
