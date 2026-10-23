# Read-only diagnostic investigation — 2026-10-23

## Production baseline and change boundary
Render service srv-da8o78egekts73dd4rug in workspace tea-da88qn7avr4c73eq2kog reports deployment dep-dbdmomdg1s2s73dsfa8g live at commit fe8b1d275643042aaa1ac066ed27fc7f033798d5.
This is an observed live deployment with a successful build, not a claim that all application functions have been verified.
No merge, deployment, database mutation, inventory change, or storefront edit is authorized by this PR.
The runtime diff is one parameter-list correction inside GET /reference-format-diagnostics. No other handler, imports, storefront files, schema, configuration, or transaction behavior changes.

## Diagnostic root cause
The query has one placeholder, $1::text[], but the deployed handler supplies [...lower] as the parameter list.
Each ID is therefore supplied as a separate SQL parameter rather than one array parameter.
A single ID is also scalar rather than a PostgreSQL text array.
The proposed correction supplies [[...lower]], preserving one parameter containing the complete deduplicated array.
Five tests exercise the registered handler with synthetic supplier responses and a strict database stub.
Before the correction the single-ID and multiple-ID tests return 502; after it all five tests pass.
These are isolated regression tests, not authenticated production endpoint verification.

## Database evidence
A Render read-only query confirms public.chattanooga_reference exists and supplier_item_id is text.
LOWER(supplier_item_id) executes successfully.
ANY with a text-array sentinel executes successfully with no match.
No row identifiers, supplier records, prices, or credentials were returned.
This rules out a missing table, missing ID column, and incompatible ID type in the inspected database.
The application connection's search_path and exact production error SQLSTATE have not been independently captured.
No supplier API call was made during this investigation.
This diagnosis repairs a diagnostic failure; it does not prove or repair the underlying supplier/catalog mismatch.

## Cloudflare checks
PR #17 head a27ea3f8df10a147d2424af416a9da4f3536ffbf has successful verify and dependency-audit checks and failed Worker builds for both pink-elephant-gun-pawn and pink-elephant-gun-pawn2.
Both Worker names also failed at earlier commit 13dd0c9b204acb15c3133eee8564e78c7bc2e0fd.
Cloudflare API access now confirms the exact failure in both Worker logs: Missing entry-point to Worker script or to assets directory.
Both triggers run npx wrangler versions upload from / with no build command. The same error is present in both Worker builds at earlier commit 13dd0c9 and PR #18 commit 784bf70, establishing a pre-existing configuration failure rather than a new regression.
The repository tree has no Wrangler configuration or root package.json; the deployed application is a Node service rooted at pe_site/server. The Worker triggers are not configured with a deployable Worker script or assets directory. Their intended current role remains to be reviewed before changing or disabling them.
Read-only Cloudflare plugin access succeeded. No build trigger, route, DNS record, Worker version, or production configuration was changed.
No check was bypassed or disabled. PR #17 remains unmerged.

## Reliability observations
Render auto-deploy is enabled on main with trigger commit. Merging can deploy production automatically; do not merge without explicit deployment approval.
The service has no configured HTTP health-check path; its TCP readiness check does not establish application-level or database health.
Render build command is npm install whereas CI uses npm ci. This is a reproducibility difference, not a demonstrated outage.
Recent error logs contain reference-format diagnostic errors from before PR #17 but no detailed SQLSTATE. The available error messages alone do not establish other failures.
No configuration change is included.

## Approval-gated validation and rollback
Before approval, compare the proposed diff against the exact production baseline and record a visual baseline for the homepage, featured sections, categories, navigation, banners, and relevant public pages.
Run CI at the exact PR head, review every failed check, and verify the current Render deployment has not moved.
With explicit merge/deployment approval only, merge and observe Render's automatic deployment rather than triggering a duplicate deployment.
After deployment, verify the exact deployed commit and authenticated diagnostic with sanitized output, and compare the storefront against its recorded baseline.
If an approved deployment regresses, obtain explicit rollback approval and use the recorded deployment artifact if retained and compatible.
A rollback restores application code only; do not change or restore database records. If the artifact is unavailable, stop and prepare a separately reviewed revert commit rather than guessing.

## PR dependency review and recommended release order
PR #18 branches directly from the production baseline and does not include or depend on PR #17.
PR #17 adds a separate SQL-probe endpoint; PR #18 fixes the existing format diagnostic and is not feature-equivalent.
Recommend PR #18 alone for the current fix. Leave #17 unmerged; consider closing it as unnecessary only after the fixed diagnostic is verified and the user agrees.
All 24 tests and the production dependency audit passed in CI run 39973767806 for the reviewed runtime change; five focused tests also passed locally.
Before any approved release, capture the storefront visual baseline and confirm exact PR head, current production commit, auth access for verification, and rollback artifact availability.
With explicit approval, merge #18 only and observe the automatic Render deployment. Do not trigger another deployment and do not modify Cloudflare configuration as part of this release.
Verify live status and commit, authenticated read-only diagnostic response, runtime errors, and storefront baseline. Stop for review on any mismatch.
Cloudflare configuration remediation is a separate decision requiring review of Worker routing and purpose; do not bypass failed checks or force a merge if repository protection blocks it.
