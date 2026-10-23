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
The failures therefore predate PR #17. The precise Cloudflare failure cause is not established.
The repository tree has no Wrangler configuration or root package.json; the deployed application is a Node service rooted at pe_site/server. A legacy or mismatched Worker build configuration is a hypothesis requiring Cloudflare logs.
No Cloudflare-specific tool was exposed; plugin discovery returned no Cloudflare result.
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
