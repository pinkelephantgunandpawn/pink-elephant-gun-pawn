# CSSI offline technical audit — October 23, 2026

Historical findings at the October 23 review. The October 24 follow-up and current release assessment are in [release-readiness-20261024.md](release-readiness-20261024.md); that document supersedes implementation limitations and test counts below that were subsequently fixed.

## Scope and production baseline

Production was observed live at `51ea3dc4f53798ec6b308423238a3bdb9b7515d9`, deployment `dep-dbdr373m8hqs73csb240`. Workspace `tea-da88qn7avr4c73eq2kog`; service `srv-da8o78egekts73dd4rug`. This session made no supplier API requests, CSV downloads, production writes, configuration changes, merges, deployments, or supplier communications. No catalog image mapping/population or sales functionality was implemented.

Protected restore branch `restore/production-2026-10-23-fe8b1d2` and tag `restore-production-2026-10-23-fe8b1d2` must remain at `fe8b1d275643042aaa1ac066ed27fc7f033798d5`. The existing restore guide describes application rollback and separate database/image recovery. A code rollback does not rewind data and requires owner approval.

## Confirmed correspondence; correction to earlier report

CSSI support's October 22 thread, ticket 9843591, states:

- Full product-feed calls are limited to one every 20 minutes; support describes this as the only rate-limited call.
- A response message indicates remaining minutes. This does not establish whether Retry-After headers exist, what quota identity is used, or whether failed requests reset the window.
- The API returns a separate CSV download URL.
- A later answer explicitly states that CSV downloading works with HTTP and not HTTPS.
- The owner already asked for an HTTPS/SFTP alternative. No reply establishing such an alternative was located in the searched correspondence.
- Another support response confirms image URLs are in the full product feed and supplies the endpoint with optional_columns=retail_map,specifications.

These are supplier statements, not newly executed transport tests. Earlier reporting that the rate window was unknown was incomplete: the existing correspondence supplies 20 minutes. Do not assume missing image permissions; no such evidence was found.

The public developer portal requires authentication for detailed documentation. Exact primary_image_only_flag semantics, complete optional-column definitions, image-column names and gallery structure remain unverified. The local parameter allowlist is implementation, not independent documentation. No captured supplier CSV/header exists in the repository inspected. Private database dump rows and unrelated Library files were not searched for supplier data.

## API request inventory

Paths below are relative to `/api/admin/chattanooga`. All are mounted behind auth and manager-role middleware. Counts describe direct supplier API calls per invocation; SQL calls are separate.

| Application path | Supplier request | Trigger | Maximum ordinary calls |
| --- | --- | --- | --- |
| GET /product-feed/diagnostics | GET items/product-feed; conditional HTTPS CSV prefix GET | Inspect product-feed columns button | 1 API + 1 file request; HTTP file blocked |
| GET /product-feed/https-probe | GET items/product-feed; HTTPS file HEAD | Direct authenticated diagnostic; no dedicated button found | 1 API + 1 HEAD |
| GET /field-diagnostics | GET items, page 1, 3 records | Check photo fields | 1 |
| GET /sku-diagnostics | GET items, item_ids filter | Check SKU | 1 |
| GET /lookup | GET items, item_ids filter | Preview SKU | 1 |
| GET /eligibility-diagnostics | GET items, first 50 | Why are items excluded? | 1 |
| GET /id-match-diagnostics | GET items, first 50 | Check supplier ID matches | 1 |
| GET /multi-page-id-diagnostics | GET items, pages 1–3, 50 each | Direct authenticated diagnostic | 3 sequential; stops on failure |
| GET /raw-id-sample | GET items, first 50 | Direct authenticated diagnostic | 1 |
| GET /reference-format-diagnostics | GET items, first 50 | Compare ID formats | 1 |
| GET /remote | GET items, requested bounded page | Load catalog / previous / next | 1 per navigation |
| GET /products/:id/availability | GET items, stored supplier identifier | Check supplier stock | 1 |
| POST /products/:id/refresh | GET items, stored supplier identifier | Refresh supplier data | 1; application also writes drafts; never invoked here |
| POST /stage | GET items for each selected identifier | Add selected to drafts | Up to 10 sequential; application also writes; never invoked here |
| GET /ffl-status/:fflNumber | GET federal-firearms-licenses/{number} | Check supplier FFL status | 1; untouched |

getItemProperties is exposed by the client but has no call site in inspected application code. chattanooga_reference.js accesses local SQL only. The client permits read-only GET, rejects redirects, keeps credentials in Authorization headers, and contains no automatic retry loop. Its credential hashing convention was not changed or independently re-certified.

No CSSI API call was found in startup, timers, cron configuration, GitHub Actions, or the dependency-test service. Catalog page load automatically calls local products/categories, readiness, fulfillment checklist, review summary and candidate summary, not supplier APIs. Repeated manual diagnostics overlap the same first-page sample; they are separate uncached requests. SKU check + preview also repeat item lookup. Browser buttons have uneven in-flight disabling; there is no global deduplication.

Two Render services were listed: production and a dependency-test web service. No cron/worker service appeared. The test service has auto-deploy off and its checked-in test Dockerfile starts only a minimal health server. Account activity outside this repository/workspace cannot be ruled out.

## 429 origin and limits of the evidence

Existing log at 2026-10-23T19:16:20.261753033Z reports ChattanoogaApiError status 429 for the HTTPS probe. Client code preserves upstream HTTP status. In production code, a HEAD 429 is returned as JSON inside HTTP 200, whereas the observed generic HTTP 429 comes from the catch around getProductFeed. Therefore the recorded failure occurred on the initial API call before HEAD. Do not retry to prove this again.

Application-wide express-rate-limit separately allows 300 requests per 15 minutes. It can also generate 429, but does not explain this specific logged supplier exception. Login limits are separate. The client discards Retry-After and supplier countdown text; no exact safe retry timestamp can be reconstructed from that log.

PR #22 shares the existing conservative 30-minute post-429 cooldown between diagnostics, propagates HEAD 429, and reports a safe stage. It is per router/process, resets on restart, does not serialize concurrent calls, does not rate-limit successful feed generation, and does not coordinate other clients. It is incremental protection, not a complete supplier quota manager. Do not reduce it to 20 minutes solely from the support message; quota/reset semantics remain incomplete. No automatic retries were added.

## Offline tests and additional hardening

The original five PR #22 tests pass. Added 20 synthetic transport/header tests cover strict HTTPS host/path/userinfo/port validation, malformed locations, BOM/quoted comma headers, image-column name detection, empty/malformed/oversized input, 64-KiB prefix bounds, stream cancellation, timeout aborts, redirects, and secret redaction. Three failed before the additional fixes:

1. The header diagnostic accepted non-default HTTPS ports although HEAD probe rejected them.
2. Unterminated CSV quoting was accepted as a successful header.
3. Header diagnostic logged raw exception text; synthetic signed-link text reached logs.

Fixes affect only the header diagnostic: reject non-default ports; validate CSV quoting before existing column extraction; log safe stage/status and omit arbitrary supplier error codes/messages. No schema, catalog normalization, storefront, upload, payment or order changes.

All 49 tests pass locally. No live network calls occur in these synthetic tests. Client malformed JSON/HTTP/redirect/credential-header tests are in the existing suite. Tests do not prove the supplier supports HTTPS or any proposed image schema.

A fresh dependency audit reported a high-severity Zod advisory affecting installed 4.6.5, despite earlier passing CI. Advisory GHSA-mrhx-c7xc-m3w5 lists 4.6.6 as patched. Dependency remediation is isolated from this diagnostic PR; freshly failing audit must not be called green or bypassed.

## Other blockers and retained risks

- Deployment config drift: Render is native Node, root pe_site/server, npm install / npm start, one instance, no HTTP health-check path. Checked-in render.yaml files instead describe Docker, /health and a different DB naming setup. They are not a safe description of live infrastructure. No settings changed.
- CI uses npm ci; production uses npm install. Lockfile/runtime reproducibility needs a separate reviewed change.
- Startup executes ensureSchema and ensureBootstrapAdmin, including inventory-regulated flag repair, admin upsert and deferred R2 migration. These are pre-existing writes on startup, not added here. Future deployment approval must acknowledge them; do not promise a deployment is database-write-free. No startup execution was run locally.
- DB TLS config uses rejectUnauthorized:false in production; no change proposed without infrastructure-specific certificate verification. Existing DB schema uses text supplier identifiers and typed category constraints. SQL compatibility evidence is in diagnostic-investigation-20261023.md; no live database query was executed here.
- Client timeout is cleared before response.json resolves, so the JSON-body stage is not covered by its timer; response size is not bounded. This is a remaining reliability issue, not permission to start background ingestion.
- Image normalization accepts only HTTPS absolute URLs with no userinfo; CSV column names are not automatically remapped. Existing admin cardImage permits HTTP URLs, unlike normalization. No image behavior was changed.
- Returned fields/columns and some other routes log raw errors or codes. Further sanitization should be narrowly tested, not mixed into transaction routes.
- Existing Cloudflare failures predate these diagnostic PRs; prior logs show missing Worker entry-point/assets with root Wrangler upload configuration. Changing Workers/DNS/check requirements is outside this session. Recheck exact-head logs before any release decision.

## Support questions prepared, not sent

Please confirm the supported secure alternative to the HTTP-only CSV download (HTTPS, SFTP, or an authenticated secure export). We will not use plaintext downloads. For the 20-minute product-feed limit, is the window per SID/account/IP, measured from request start or completion, and do failed requests restart it? Are Retry-After headers supplied, and what is the documented format of the remaining-time message? Does obtaining a new download location count as generating a new feed, and can an existing location be reused securely? Please provide the current parameter reference for primary_image_only_flag and optional_columns, and a redacted header-only schema showing primary and additional image fields. Do not send tokens or signed feed links in ordinary email.

## Next steps and approval boundary

1. Review separate Zod security update and diagnostic PR #22; refresh CI/security audit at exact heads. No merge/deploy authorized by this report.
2. Obtain supplier secure-transport and quota answers before any separately approved live capability test. Known supplier statement is HTTP-only; no need to keep probing it.
3. Plan process-wide quota/deduplication only after account sharing/reset semantics are understood. No background jobs or automatic retries.
4. Independently review startup writes and Render configuration drift before future deployments. Preserve current storefront and restore point.
5. Merge/deploy, production/config/database changes, supplier messages, rollbacks and any new supplier test require separate explicit approval. PR #17 remains unmerged.
