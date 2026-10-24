# General inventory admin workspace

The existing admin navigation gains **Inventory Workspace**. It preserves the original store tools and uses the existing `api()` helper, Bearer session, authentication middleware and manager/admin role policy. It creates no accounts and changes no login/password/bootstrap handlers.

## Isolation and authorization

`GET /api/admin/inventory-workspace` requires the existing signed, unexpired session and manager/admin role. A single parameterized SELECT checks the existing user is active and still privileged. Disabled, missing and demoted accounts are denied. Responses are private/no-store; errors are generic. No POST/import endpoint or database writes exist.

The authenticated endpoint serves a self-contained template bundled from fixed repository files. The committed template is regenerated with `node pe_site/server/scripts/build_inventory_workspace.mjs`; a parity test requires it to match the reviewed sources. Runtime files stay inside the Render server root. The parent mounts it with `srcdoc` in an opaque-origin iframe (`sandbox="allow-scripts"`, no allow-same-origin). No token or account data is passed to the frame. CSP denies connections, forms, embedded objects and arbitrary scripts; only a fresh script/style nonce and explicitly approved HTTPS image hosts are permitted. Original local illustrations are embedded as data images. No public dashboard HTML route or server image proxy is added.

CSV selection, decoding, mapping, validation and history run only inside this frame. Contents never enter the API, server logs, browser URL, parent admin DOM, persistent browser storage, or repository. Navigation away, logout, page hide/tab hiding, cross-tab token changes, reload and session expiry purge the frame and its tab-only contents. History is intentionally not durable. Revoked-account status is checked on each workspace load; existing signed-session behavior elsewhere is unchanged.

## Features and limits

24 synthetic non-weapon merchandise records; overview; search/filter/sort/pagination; detail gallery; image validation/error/missing states; data-quality warnings; responsive navigation; CSV mapping and validation; inspection history.

Reuses PR #29's pure parser. UTF-8 and explicitly selected Windows-1252 decoding in memory; file is unchanged. Limits: 1 MiB, 200 records, 200 columns, 65,536 characters per cell. Oversize files are rejected before reading. All rows and exact identifier strings are retained; no classification, pricing, publishing, syncing or ordering.

External image sources require HTTPS, an approved host (`images.unsplash.com` or `images.pexels.com`) and a second explicit load action. No referrer or credentials are sent; anonymous CORS may cause an otherwise valid image to fail. URLs/hosts are syntax checks, not proof of accessibility or ownership. No live supplier calls are used.

## Verification and release

Run `npm test` in `pe_site/server`, and `node --test tools/inventory-dashboard/test/*.test.mjs` from the repository root. Tests cover real existing auth middleware, expired/unauthorized/disabled/demoted sessions, allowed roles, read-only SQL, sanitized failures, bundle parsing/CSP, sandbox/lifecycle, CSV bounds and general UI models. Browser review uses an isolated fixture admin session and synthetic data, never production credentials or inventory.

This release is stacked on #30 (which includes #29). Review the cumulative candidate once; do not merge all overlapping PRs independently. No production merge/deploy is authorized by this document.

Render is a native Node service rooted at `pe_site/server`, with `npm install` / `npm start` and automatic main deployment. It does not execute the two separate Cloudflare `wrangler versions upload` checks. Cloudflare logs for both #30 checks confirm missing Worker/asset entry-point failures. No check is disabled or bypassed. The generated template is inside the server root, so runtime access to files outside that root is unnecessary. No production configuration changes are included.

Before owner-approved release: confirm exact candidate/CI, resolve required-check policy for the separate Worker failures, revalidate backup, preserve startup read-only mode, verify the committed template is included in the Render checkout, then perform one automatic deployment and read-only owner login/navigation/synthetic CSV smoke checks. No migrations, inventory repairs or account writes are added. Code rollback must preserve the current database and startup protection; never restore an old database over new business records.
