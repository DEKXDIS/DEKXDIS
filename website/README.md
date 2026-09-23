# DEKXDIS website

This directory contains the static marketing site for DEKXDIS. The site describes the Windows desktop product, which is free to download and charges a 0.05% DEKXDIS partner fee on executed CoW trades. CoW fees and network costs are separate.

The source is deliberately small: Vite, vanilla TypeScript, hand-written CSS, inline SVG graphics, and local screenshots. Run `npm run dev` to preview it and `npm run build` to create the Cloudflare-ready `dist/` directory.

Download and repository links are in `index.html` and `public/_redirects`. The user guide is published as `/user-guide.html`; its editable source is `../docs/dekxdis-user-guide.html`. Keep the published guide, `guide.css`, and `guide-images/` synchronized with `../docs/` before building.

`src/module-catalog.json` is empty. Only add metadata from verified, published module artifacts.

The homepage does not advertise or bundle strategy modules. Module builds do not deploy this website.

The DEKXDIS deployment targets `dekxdis.com`. Build with `npm run build` in this directory and deploy `dist/` to the new account's Cloudflare Pages project after its domain has been configured.

The branded homepage demos are sequences of actual app screenshots captured with the isolated `../scripts/product-demo/demo.html` fixture. They use example balances and a mocked order submission. Run the root Vite dev server to open that fixture; `node scripts/product-demo/encode.mjs` from the repository root regenerates the clips from the saved frames using FFmpeg.

The repository is currently private. Its release and source links require repository access until public distribution is configured. See `../docs/rebrand-status.md` for the remaining launch requirements.
