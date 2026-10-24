# Conditional release gate and proposed startup mitigation

The combined release PR is held. The owner's approval requires no startup product-record changes, verified admin access/recovery behavior, protected restore refs and no bypassed security checks. Passing unit tests is not a production-data guarantee.

## Original combined candidate

PR #27 combines exact blobs from #24 a3d83690de3cf89a63a69b8d88ecb49a439b7e6d, #26 30c47d70788692f06fb6e6b2357ee899e5d28478, #22 858113ff0f01c9ab829b80a986a39fde04f79e6f and #25 4e8f979657aa633495e1eb8da57b680e22600563. Commit 8ddc9e82d88ab895281d01642761471fec716844. All 76 local tests passed and production dependency audit reported zero vulnerabilities. No source PR was merged.

The current entrypoint still calls ensureSchema, including inventory regulated-flag repairs, and schedules image migration after listening. PR #26 alone does not prevent these writes. Code rollback cannot undo such effects.

## Read-only evidence, not a future safety proof

A read-only transaction against the named Render database confirmed core schema columns, one active admin, zero regulated-flag repair candidates and zero inventory/batch data-image migration candidates. No IDs, images, prices, hashes, credentials or row contents were returned. Counts can change before deployment; the tool connection is not proof of the application's exact DATABASE_URL/search_path. A live admin credential/recovery test was not performed. These facts do not remove the release hold.

## Mitigation proposed for separate approval

Add PE_STARTUP_MODE with normal (default) and read-only values. This patch alone preserves normal startup behavior. Selecting read-only:

1. Performs a metadata SELECT to check core existing tables/columns, failing closed on missing schema/database errors.
2. Does not invoke ensureSchema or ensureBootstrapAdmin.
3. Does not schedule automatic R2 migration.
4. Starts the same application routes. It is a startup-only safeguard, not a global read-only database mode, and does not change normal customer/admin request handling.

No Render settings were changed. No mode was enabled in production. Unknown mode values fail before startup operations. Core-column checks are not exhaustive schema certification. This mode is intended only for an already provisioned database with separately verified compatible schema. Future schema changes would require a separately approved migration path.

Six tests cover read-only/no-writers, missing schema, DB failure, normal sequencing, invalid mode and the actual index.js entrypoint with all startup writers/timers set to fail if called. The full candidate plus mitigation passes 82 local tests. They use synthetic dependencies/loopback middleware; no live DB/application startup was executed. Database concurrency/restore rehearsal is not claimed.

This mode also avoids invoking PR #26 at startup, preserving the existing account without seed/reset activity. Normal-mode #26 behavior remains an intentional reviewed change: ADMIN_PASSWORD edits no longer rotate an existing account on restart. Do not claim full password-recovery compatibility until the owner-approved recovery procedure and live login are verified.

## Mandatory condition assessment before any merge

| Condition | Evidence / remaining gate |
| --- | --- |
| Automated tests | 76 combined tests; 82 with mitigation; exact-head CI required |
| Dependency security | Local combined audit zero; exact-head CI required |
| Firearm product data unchanged | No product records changed in this session; startup risk remains until mitigation approved/enabled and verified |
| Transaction workflows unchanged | No firearm purchasing/payment/shipping/FFL handlers edited; dependency compatibility is targeted, not exhaustive E2E proof |
| No product startup writes | Original candidate fails this gate; mitigation is prepared but unapproved and not enabled |
| Homepage/design preserved | No homepage/style/category/featured markup edits; shop change only initial search query application |
| Existing admin access | Active admin count 1; live credentialed sign-in still required |
| Bootstrap/recovery | Unit preservation checks pass; owner must approve intentional initialization semantics/recovery procedure |
| Supplier ordering/publishing disabled | Existing disabling handlers unchanged; no enabling code added |
| No insecure downloads | HTTPS checks retained; no supplier downloads performed |
| No supplier API requests | None performed; startup does not call supplier APIs |
| Restore branch/tag | Must recheck exact protected refs before release; never modify them |
| Backup/export available | Verified saved archive must pass current integrity preflight; full restore rehearsal remains unperformed |
| Render/startup review | Native Node auto-deploy main; no config changes; startup effects explicitly documented |
| No check bypass | Cloudflare pre-existing failures remain; do not disable or override required checks |

## Approval needed, then further validation

Owner approval is needed to include this mitigation and set PE_STARTUP_MODE=read-only for the single coordinated release. Setting a Render variable can itself deploy/restart a service; do not apply it separately or guess how to avoid an intermediate startup. Prepare and verify a concrete deployment sequence (including any temporary auto-deploy control) before requesting final execution approval. Do not deploy current code merely to set the variable: current production does not understand the new flag and still runs writers.

After approval in principle, verify live admin credentials securely, application schema dependency, exact artifacts/CI and how Render can apply the variable and new code in one approved deployment. No additional approval is implied for changing passwords, product data, DATABASE_URL, schema, security checks or transactions. If any gate remains unknown, keep release held.

Rollback requires separate approval. Preserve the original restore point and all current data. A rollback to code that lacks this flag would again execute its original startup writers, so do not assume an older artifact is a safe no-write rollback. Any rollback procedure must explicitly address that risk before execution.
