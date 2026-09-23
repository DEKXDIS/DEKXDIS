# DEKXDIS conversion status

## Completed

- Fresh source repository: https://github.com/DEKXDIS/DEKXDIS. Its initial commit contains the current local source, with no imported history from the former GitHub repository.
- DEKXDIS branding in the app, package metadata, guide, website, links, and contact address.
- New `.dekxdis-module` packages and runtime name, with compatibility for existing signed modules.
- Windows executable and checksum published in the new repository's `v1.2.12` release.
- Website demo sequences, workspace screenshots, and branded guide screenshots refreshed from the current app with example data.
- App build, native check, module compatibility tests, and website build passed.
- Railway project renamed DEKXDIS. The `updates.dekxdis.com` custom domain is created but awaits DNS.

## Required before launch is complete

1. Authenticate the DEKXDIS Cloudflare account, create/deploy its Pages project, and attach `dekxdis.com` and the desired `www` alias. Neither the new domain nor the old production website has been deployed with this checkout yet.
2. Choose public source or a separate public binary distribution location. The new GitHub repository and its release are currently private, so anonymous website visitors cannot follow the source/download links.
3. Add Railway's requested CNAME and ownership TXT records for `updates.dekxdis.com` in Cloudflare. Verify HTTPS, `/health`, `/version`, and `/stats` without calling `/check`.
4. Once that endpoint works, change `src/services/updateService.ts` and `website/src/counter.js` to the new address, rebuild the executable, and update the release asset and checksum. Both clients currently retain the functioning previous update-service address.
5. Deploy the branded site to the old site's Pages project as requested, then verify both production sites, their guides, download links, and counters. Preserve the old update domain for existing installed clients.
6. Rename the Railway service's administrative label if access permits. Project rename succeeded, but the service rename returned `Not Authorized`; its old label does not affect the custom-domain routing.

## Compatibility identifiers

Legacy wallet filenames, the application data identifier, persisted settings keys, signed-module format marker/publisher identity, and existing module IDs remain intentionally compatible. Changing these strings without a migration can make existing wallets or settings appear missing, or invalidate previously signed modules. They are not public product branding.

The browser demonstrations use mocked data. They do not verify funded trading or an installed Windows executable.
