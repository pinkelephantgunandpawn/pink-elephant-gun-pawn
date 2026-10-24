# Engineering and release readiness — October 24, 2026

## Production safety

Observed production commit: `51ea3dc4f53798ec6b308423238a3bdb9b7515d9`; Render deploy `dep-dbdr373m8hqs73csb240` remains live. No production changes, supplier API requests, supplier CSV downloads, messages, or deployments were made in this session. PR #17 must stay unmerged. Protected restore refs remain at fe8b1d275643042aaa1ac066ed27fc7f033798d5.

## Reviewed development changes

- PR #24: Zod 4.6.6 plus patched multer 2.5.0 and body-parser 2.4.0 (transitive qs update). New advisories detected by today's audit mean yesterday's green audit is not sufficient. Targeted schema compatibility tests instantiate actual declarations using synthetic general-merchandise fixtures; no handler/transaction execution. Isolated HTTP middleware tests cover compressed JSON, trailing bytes and small multipart upload limits. All 31 local tests pass; fresh audit reports zero vulnerabilities at the time checked. No application schema or handler edits. Multer advisory requires async fileFilter; that configuration was not found in this application, so exploitability is not established merely by an audit finding.
- PR #22: diagnostic feed calls now reserve the 20-minute window before awaiting the supplier, preventing concurrent calls within one process. Success refreshes the interval from completion. A fresh process fails closed for 20 minutes, avoiding immediate repeated feed generation after a restart without adding DB/disk writes. This is conservative and intentionally changes diagnostic availability after deployment. It is not account-wide coordination, does not persist a longer provider cooldown across restarts, and cannot coordinate independent clients. No automatic retries.
- Supplier numeric or HTTP-date Retry-After values are parsed without exposing bodies/URLs; valid longer waits are retained. Unknown/invalid headers use the conservative 30-minute fallback. The supplier's free-text countdown format is not guessed or copied to logs.
- Client fetch and JSON parsing share a 15-second deadline. JSON streaming is bounded to 4 MiB, cancels on completion/error and redacts malformed/network failures. HTTP errors preserve status even if their bodies are not JSON. Only the known rate-limit code is retained from JSON errors. The limit is a defensive bound, not a claim about the real feed's schema or size; no bulk CSV ingestion is introduced. The JSON-only fallback exists for injected fixture adapters; native fetch responses use the bounded stream path.
- CSV diagnostic rejects non-default ports, insecure transport, redirects, malformed quoting, non-CSV/plain/octet-stream content types and oversized headers/prefixes. CSV HEAD and prefix-download 429 propagate cooldown metadata. Existing header limits remain 16 KiB / 64 KiB. All 64 local tests pass.
- Shop search draft: apply existing `q` parameter to the search input before initial render. Verified header Music/guitar search navigated to the correct URL but the production shop ignored q. Change affects only initialization; no layout, data records, category structure or transaction code changes. Three focused offline tests; two fail before the fix.
- Bootstrap draft: replace startup account upsert's conflict UPDATE with DO NOTHING. Existing credentials, role and disabled state survive restarts; missing-account bootstrap remains. Two focused tests; preservation fails before the fix. No credential values included. This intentionally stops environment-password changes from rotating an existing account on restart. Owner must approve that behavior; password rotation must use a separate controlled process. Tests use inert SQL stubs, not a live PostgreSQL concurrency rehearsal. Atomic conflict behavior comes from PostgreSQL's ON CONFLICT clause.

## Website and security inspection

Live homepage retains all twelve featured firearm cards and original category/navigation sections. Sampled featured images had no completed failed loads; lazy images were not all loaded, so this is not a complete asset audit. Browser console showed an extension-generated metadata error, not an application error. Opening a second menu closes the prior menu. Music search routing worked; missing query application was reproduced. Static HTML links in index/admin/shop/account had no missing .html targets. No production inventory writes or cart/checkout interactions were used.

No high-confidence credential literals or secret key files were found in the inspected current source snapshot; this is not a historical secret scan or a guarantee that no credential exists anywhere. Credentials remain server-side in Authorization headers. CSSI routes are behind auth and manager role. SQL inputs use parameters in the inspected diagnostics. No authorization bypass was established.

Current JWT auth trusts verified role claims for up to eight hours without rechecking account active/role. Revocation after deactivation can therefore be delayed; no change made because a global authorization change warrants separate review. Browser tokens are stored in localStorage, a retained exposure risk if XSS exists; no token was inspected. Database TLS rejectUnauthorized:false is retained pending infrastructure-specific certificate review. Some legacy admin image rendering accepts HTTP while supplier normalization accepts HTTPS only; do not remove existing images as a workaround.

Mobile CSS was reviewed statically; a physical-device/full viewport matrix was not available. No mobile accessibility compliance claim is made. No broad storefront or category changes were prepared.

## Startup and deployment findings

Render is native Node, root pe_site/server, npm install / npm start; CI uses npm ci with lifecycle scripts disabled. Docker blueprints in the repository do not represent live service configuration. No Render config changed. Runtime dependency reproducibility should be aligned via a separately approved config change after checking required lifecycle scripts.

Startup schema statements include IF NOT EXISTS but still execute DDL and inventory regulated-flag repair. The repair's WHERE clause is idempotent for already-repaired rows; it is not a read-only operation. The bootstrap patch removes repeated account resets only. Deferred image migration uses an in-process flag, not a cross-process lock; deployment overlap may duplicate object uploads or overwrite a concurrent image edit. No speculative R2 migration rewrite was made because it changes inventory/image persistence behavior. SQL schema/index operations can race across simultaneous startup instances; one configured service instance does not prove deployment overlap cannot happen. These remain explicit release risks.

Render /health exists and checks DB connectivity, but Render has no configured HTTP health-check path. Configuring it needs approval and is not part of these source PRs. Existing error-level log query from Oct 24 midnight UTC returned no entries; log coverage is limited to queried labels/window.

## CI and branch coordination

Only one GitHub workflow was found: Chattanooga safety and dependency audit. It uses read-only token permissions, Node 24, npm ci, npm test and a production high-severity audit. Keep the audit enabled. Cloudflare missing Worker entry-point failures predate these patches; no Wrangler scaffolding, DNS changes or check bypass was added. Their intended service role must be established before config changes.

All fixes branch from the production baseline except PR #22, which has additive commits on its original branch. PR #24 package files do not conflict with the diagnostic files. Search changes shop.html; bootstrap changes only one SQL conflict clause in index.js. Startup/test branches need the approved dependency changes for a green fresh security audit. Dependabot PR #23 is separate and was not modified; do not merge it blindly alongside lockfile changes.

Recommended review order: dependency security PR #24, diagnostic PR #22, bootstrap initialization draft, then shop search draft. Review order is not permission to merge each into auto-deploying main. To avoid several startup/deploy cycles, prepare a temporary release branch combining only explicitly approved fixes and run the full tests/audit there. Prefer one reviewed release PR / one Render automatic deployment after final approval. If individual main merges are desired instead, obtain explicit approval for every automatic deployment and its startup effects. Do not silently toggle auto-deploy or issue manual deploys.

## Approval-gated release checklist

1. Recheck production SHA, all PR heads, exact changed-file scope and current audit. Resolve conflicts on isolated branches and rerun combined tests; never force main or restore refs.
2. Verify source restore branch/tag and readable ZIP/checksum manifest. Existing export is dated Oct 23; arrange a fresh DB export/object manifest before release if production data changed. Do not overwrite or import over production. A recovery rehearsal remains unperformed. Secret values are intentionally absent from the kit and require secure owner retention.
3. Obtain explicit approval for chosen commits, intentional restart guard/bootstrap behavior, startup DDL/inventory/image effects, deployment and any infrastructure change. Existing original backup remains protected even if a newer restore point is created separately.
4. Merge only approved release content. Observe automatic Render deployment and exact live SHA; no duplicate manual deployment. Monitor build/startup logs, DB health, admin access and public pages.
5. Smoke-test public homepage/categories/featured cards, general-merchandise search, navigation/dropdowns, image loading and admin sign-in without inventory writes or transactions. No supplier calls during smoke testing: diagnostic requests are separately gated and now begin with a 20-minute startup cooldown.
6. Compare current homepage/admin source and reviewed functional baseline. Stop on unexpected changes; do not auto-rollback.
7. Rollback requires separate approval. Prefer retained pre-release artifact if compatible; otherwise prepare exact reviewed revert/rebuild. Code rollback does not undo startup DB/image effects or restore external configuration. Never restore DB records or change DATABASE_URL as part of a code rollback without separate explicit approval.

## Supplier dependency

Known facts remain unchanged: full feed once per 20 minutes, images present per support, CSV HTTP-only per support, secure alternative already requested. Do not perform further supplier requests or weaken transport checks. HTTPS/SFTP alternative and quota identity/reset/free-text countdown format remain external questions. No catalog image population or supplier transaction work is included.


## Final offline integration check

The temporary combined candidate (dependency patches, diagnostics, bootstrap and shop-search fixes) passed all 76 tests after a clean npm ci; its fresh production dependency audit reported zero vulnerabilities. No production server or database was started. Twenty-two inline script blocks across index/shop/admin/account/Chattanooga passed node --check. Sampled static HTML targets had no missing files. These results do not replace post-approval deployed/browser/mobile verification.

The saved Library backup was downloaded again and verified: 109,959,524 bytes; 508 members; 499 images; database export included; every recorded checksum passed; ZIP SHA-256 a0d0c56ce88f37801c03bb7bc17378681d500af494c8a056f48ed648a937241f. An incomplete local working copy was preserved separately and the working ZIP refreshed from this verified saved artifact. No Library version, source restore ref, database or storage object changed.
