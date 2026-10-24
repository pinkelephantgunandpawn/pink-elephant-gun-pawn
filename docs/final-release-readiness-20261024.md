# Final release readiness — October 24, 2026

## Release decision

Hold production until the startup setting is staged without deployment, the owner verifies the existing administrator credentials, and the final backup/configuration preflight is completed. The owner has approved incorporating PR #28 and staging PE_STARTUP_MODE=read-only with Render Save only. No additional approval for those two actions is being requested. No main merge, deploy, production data write, supplier request or restore-reference modification occurred.

The release combines #24, #26, #22 and #25 from commit 8ddc9e82d88ab895281d01642761471fec716844 and the approved #28 implementation at 607a66ebaef52248d473a953f42db7764c79e6eb. This report and authentication regression tests add no request-handler changes. The original startup-mitigation document records the earlier proposal stage; this report supersedes its pending-approval statements.

## Verified startup and isolated runtime behavior

The actual index.js startup calls prepareStartup before listening. In read-only mode it issues one metadata SELECT, skips ensureSchema (including inventory repairs), skips ensureBootstrapAdmin, and suppresses the deferred R2 migration timer. Invalid mode, missing core columns and database errors fail closed. No supplier request is issued at startup. The mode affects startup only; request handlers retain normal database access.

The saved PostgreSQL directory-format export was decoded with official PostgreSQL 18.6 pg_restore. All 18 tables and 86,080 rows were loaded into a disposable in-memory PostgreSQL 18.6 PGlite engine, including table constraints and sequences. The SQL dump's empty restore search_path was reset to public for the application session. This is an application/data restore rehearsal, not a native Render infrastructure or disaster-recovery rehearsal.

The actual application module was then loaded with only its Pool replaced by an adapter to that disposable database, loopback binding and a synthetic environment. All non-loopback fetches were rejected. During startup the adapter rejected every non-SELECT query. It observed exactly one metadata SELECT, no startup writers, and identical pre/post-start digests across every restored table. Health and public inventory reads passed. A new synthetic account was created only in the disposable copy; actual HTTP login, session validation and authenticated inventory reads passed. Login preserved account password hashes and roles. Deactivating only the synthetic account rejected its subsequent login. No production account was changed. No supplier API requests occurred.

The named production database was inspected read-only: PostgreSQL 18.6, public schema, required core columns present, and one active administrator. The private application DATABASE_URL/search_path mapping has not been inspected independently; confirm its dependency on the named database without publishing its value before release. No secret or exported record belongs in GitHub.

## Authentication

89 automated regression tests pass locally, including seven new tests using the actual authentication handlers and actual bcrypt/JWT/Zod dependencies. They cover login, eight-hour issuer-bound session claims, audit insertion, password/role preservation, disabled-account rejection, invalid input, generic credential errors, role authorization, and expired/incorrect-issuer/missing sessions.

Existing limitation: session validation is stateless. Disabling an account prevents a new login but does not revoke an already issued token before its eight-hour expiry. This behavior predates the release and is preserved, not silently changed. No self-service administrator password-reset/recovery route exists in the inspected application. PR #26 intentionally stops ADMIN_PASSWORD changes from overwriting an existing account at startup; read-only startup also skips bootstrap entirely. Do not rely on restarting with a new environment password as a recovery procedure. Any actual credential recovery must be separately authorized and target only the account, never inventory or an entire database restore.

Owner credential test, no password sharing: open /admin.html in a private browser window, sign in with the existing credentials, confirm the dashboard and inventory list load without edits, reload and confirm access persists, then sign out and confirm protected access is no longer available in that window. Do not save products, create orders, or alter accounts. Report success or the exact non-sensitive error. Synthetic tests do not prove knowledge of the current production password.

## CI and Cloudflare

The previous exact #28 head passed GitHub verify and dependency-audit jobs. The expanded 89-test head must pass these jobs again. Local npm audit --omit=dev reports zero vulnerabilities at all severity levels.

GitHub branches/main reports protected=false and required_status_checks enforcement_level=off with empty contexts/checks; repository rulesets is empty. Direct branch-protection detail access returned integration 403, but the branch response explicitly reports the effective status above. No required check was disabled or overridden. Both Cloudflare builds at the prior head still report Missing entry-point to Worker script or to assets directory. They are separate from the native Render build/start commands and predate these changes. Adding a Worker entry point or changing Cloudflare triggers could deploy a different storefront; no such change was made merely to obtain green checks. Recheck branch rules and exact-head checks before release.

## Render configuration and Save only

The named workspace/service reports native Node, rootDir pe_site/server, build npm install, start npm start, automatic deploys on main commits, one instance and TCP health checking. No configured pre-deploy command was reported. The package has no application install/start migration hook beyond the reviewed index.js startup. Do not substitute the repository's older Docker Blueprint for the actual service configuration.

Current Render environment-variable documentation explicitly states Save only saves values without triggering a deploy and applies them on the next deploy. The connected environment-update tool has no Save only/deploy-control parameter. The dashboard is signed out; therefore the flag was NOT staged through an unverified API alternative. Use the authorized Save only dashboard action after authenticated access is available, preserve every other variable, and verify no deployment was created. Do not choose Save and deploy or Save, rebuild, and deploy.

## Backup and release sequence

The October 23 restore ZIP opens, contains 508 files, the database export, source archive, recovery instructions and 499 available product images. SHA-256 a0d0c56ce88f37801c03bb7bc17378681d500af494c8a056f48ed648a937241f. The saved source restore commit is fe8b1d275643042aaa1ac066ed27fc7f033798d5; current production source remains recoverable at 51ea3dc4f53798ec6b308423238a3bdb9b7515d9. The database export is from October 23 at 11:24 AM Eastern, not a current atomic production snapshot. Its successful isolated restore does not recover later orders. Three previously missing image objects remain documented in the backup guide; this release does not modify them.

Before a main merge: verify exact release files/head and CI, current production head, protected refs, named DB/application mapping, current backup/PITR availability, administrator credential test, Save only staging and absence of an unintended deployment. Record read-only predeployment inventory/account/schema digests privately without returning records or hashes in public logs. Use one approved main merge and one automatic Render deployment only. Never separately merge the constituent PRs into main.

After live: verify deployed SHA, health, homepage, search, navigation, featured sections, existing product images/pages and authenticated admin reads. Compare private record/schema digests and explain any legitimate concurrent customer changes rather than overwriting them. Inspect sanitized logs for unexpected initialization, migration or supplier activity. Do not create orders, charge cards or perform transaction tests. Startup has no schema/product migration to undo.

Rollback plan: preserve the current production database and storage so postdeployment orders/accounts remain intact. Never import this historical dump over production. If a regression occurs, stop and obtain separate rollback approval. A historical Render artifact reuses its historical environment and old startup writers; PE_STARTUP_MODE is not understood by the old code. Therefore a safe code-only recovery must use baseline source plus the reviewed startup guard, with read-only mode retained and compatibility revalidated, rather than assuming the old artifact is write-free. Any database disaster recovery must restore separately, reconcile newer records, and require explicit cutover approval. The protected restore branch/tag remain untouched.
