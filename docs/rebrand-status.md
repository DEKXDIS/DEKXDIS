# DEKXDIS conversion status

## Completed

- Fresh source repository: https://github.com/DEKXDIS/DEKXDIS. Its initial commit contains the current local source, with no imported history from the former GitHub repository.
- DEKXDIS branding in the app, package metadata, guide, website, links, and contact address.
- New `.dekxdis-module` packages and runtime name, with compatibility for existing signed modules.
- Windows executable and checksum prepared in the private repository. The `v1.2.12` release is a draft; publishing the program is outside this conversion task.
- Website demo sequences, workspace screenshots, and branded guide screenshots refreshed from the current app with example data.
- App build, native check, module compatibility tests, and website build passed.
- Railway project renamed DEKXDIS. The `updates.dekxdis.com` custom domain is created but awaits DNS.
- Website deployed to the DEKXDIS Cloudflare account on 2026-09-23. `https://dekxdis.com/` serves the renamed site over HTTPS; the guide, CSS, chart image, and demonstration video return HTTP 200. Pages project: `dekxdis`; deployment: `6c1693e7.dekxdis.pages.dev`. No program binaries are hosted on the website.

## Required before the conversion is complete

1. The requested `dekxdis.com` deployment is complete. Its apex CNAME points to `dekxdis.pages.dev`. The existing site's deployment is tracked separately below.
2. Keep GitHub private and the program unreleased. Do not add website-hosted downloads or change source visibility. Public download access is not a requirement of this conversion.
3. Add Railway's requested CNAME and ownership TXT records for `updates.dekxdis.com` in Cloudflare. Verify HTTPS, `/health`, `/version`, and `/stats` without calling `/check`.
4. Once that endpoint works, change `src/services/updateService.ts` and `website/src/counter.js` to the new address and rebuild locally. Both clients currently retain the functioning previous update-service address. Do not publish a release.
5. Deploy the branded site to the old site's Pages project as requested, then verify both production sites, their guides, download links, and counters. Preserve the old update domain for existing installed clients.
6. Rename the Railway service's administrative label if access permits. Project rename succeeded, but the service rename returned `Not Authorized`; its old label does not affect the custom-domain routing.

## Compatibility identifiers

Legacy wallet filenames, the application data identifier, persisted settings keys, signed-module format marker/publisher identity, and existing module IDs remain intentionally compatible. Changing these strings without a migration can make existing wallets or settings appear missing, or invalidate previously signed modules. They are not public product branding.

The browser demonstrations use mocked data. They do not verify funded trading or an installed Windows executable.
