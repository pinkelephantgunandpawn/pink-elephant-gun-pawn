# General inventory workspace preview

This isolated browser-only workspace uses 24 synthetic non-weapon merchandise records and original local SVG illustrations. It is not mounted into the live admin or storefront. It has no database, API calls, account/session implementation, persistence, pricing, approval/publishing, or ordering controls.

## Features

- Overview, search across name/identifier/brand, category/availability/image filters, numeric and text sorting, pagination and empty states.
- Item detail drawer with keyboard focus containment, Escape/close handling, image gallery, source information and quality warnings.
- Image library with missing, invalid-source, explicit external-load and loading-failure states. Only HTTPS sources on the two demonstration image hosts in `model.mjs` are allowed; CSP enforces the same hosts. Requests use no referrer and anonymous CORS. External images require a second explicit action. An allowed URL is not proof of image accessibility or ownership. There is no server proxy.
- CSV preview with explicit column mapping, repeated identifier and missing-field detection, per-record report and tab-only inspection history. Records are retained individually. Mapping changes invalidate old results. HTML-like values are displayed as text.
- UTF-8 or explicitly selected Windows-1252 decoding in memory. The source file is never changed. Preview limits: 1 MiB, 200 records, 200 columns, 65,536 characters per cell; oversize input is rejected before reading/decoding. This is a bounded sample inspector, not a full bulk importer.
- Responsive navigation and independently scrollable inventory tables.

## Dependency and local review

Built on PR #29's pure `pe_site/server/offline_csv_preview.js` parser. Review/merge #29 before this PR; neither is authorized for deployment by this document. This PR intentionally contains that dependency when compared with main.

From the repository root, serve the checkout with an isolated local static server and open `/tools/inventory-dashboard/`. Do not mount the repository root on production. The current production server serves `pe_site`, so this `tools` directory is not a production route.

Run `node --test tools/inventory-dashboard/test/*.test.mjs`, plus the existing server suite. No new packages or dependency changes are required. CI adds the dashboard regression command without removing existing safety or dependency-audit checks.

## Before live admin integration

Obtain design approval; implement a separately reviewed authenticated admin mount and authorization tests; choose isolated staging storage and retention rules if persistence is desired; test again against the real admin shell without touching existing product records. Any production integration requires separate approval. No confidential input files, real inventory records or analysis output belong in this public source tree.
