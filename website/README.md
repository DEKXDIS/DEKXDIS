# DEKXDIS website

Static marketing site and illustrated user guide for DEKXDIS. The application charges no flat DEKXDIS trading fee; its CoW partner policy requests 25% of surplus, capped at 1% of order volume. CoW protocol fees and network costs are separate.

Run `npm run dev` to preview and `npm run build` to create `dist/`. The site uses Vite, TypeScript, CSS and local media. Download links point to GitHub Releases; program binaries belong in releases, not this source tree.

The editable user guide is `../docs/dekxdis-user-guide.html`. Keep `public/user-guide.html`, `public/guide.css` and referenced `public/guide-images/` synchronized with the corresponding files under `../docs/` before building.

The existing Cloudflare Pages project is `dekxdis`, serving `https://dekxdis.com`. Deploy with `npx wrangler pages deploy dist --project-name dekxdis --branch main --profile dekxdis` using the authorized DEKXDIS account. Preserve the existing project and domain configuration.
