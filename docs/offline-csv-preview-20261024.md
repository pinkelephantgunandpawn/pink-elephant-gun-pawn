# Local CSV sample inspection — no production import

## Confirmed access blocker

The existing HTTPS API client already requests items/product-feed with optional_columns=retail_map,specifications and primary_image_only_flag=1. The expected response is JSON containing product_feed.url, a separate CSV location, not inline image records. Existing code checks the approved API host and customer-feed path, blocks plaintext downloads, rejects redirects and reserves a shared 20-minute feed window. No supplier request was made for this investigation.

Read correspondence: supplier support ticket 9843002 (October 22) confirms images exist in the full feed and supplies that endpoint. Ticket 9843591 confirms the 20-minute limit and separate CSV URL, then states on October 22 at 2:02 PM Eastern that CSV downloading supports HTTP but not HTTPS. The owner's October 22 2:12 PM request for SFTP or another HTTPS method has no subsequent answer in the searched thread. No supported authenticated HTTPS file endpoint or SFTP alternative was established. Adding authentication to an HTTP download does not provide encryption; do not try guessed hosts/paths, send API credentials to image hosts or downgrade transport.

Public developer documentation requires login. Exact image-column names, gallery encoding, primary_image_only_flag semantics and identity-column relationships remain unverified. The endpoint and image availability are confirmed; a securely available feed sample is the missing evidence. This is not evidence of missing image permissions. No new supplier email was sent.

## Owner-provided input

Provide the header and 3–10 complete rows from an existing legitimately obtained full feed, or a secure export supplied through an approved dealer portal, HTTPS transfer or SFTP. Do not use an HTTP download as a workaround. Preserve quoted CSV structure, all plausible CSSI item-number/SKU columns and image columns. Omit unrelated price/customer data if possible. Do not paste SID, API tokens or the generated signed feed-download link into chat. Upload the sample privately; never commit real supplier CSVs or image URLs to GitHub.

No full-feed CSV with image fields was available in the inspected source/correspondence. A true small-sample identity match or image accessibility result cannot be claimed until that input exists. Synthetic records exercise the parser and matching behavior only.

## Offline workflow

This development-only CLI does not start the application, import a database client, call the supplier, fetch images, save rows or write either input file. It is not a deployed admin upload endpoint. Do not use the existing admin reference-import button for this test: that route deletes/replaces classification reference records.

1. Keep the sample and an optional independently exported identifier-only reference sample in a private local directory outside Git. Limits: UTF-8, 1 MiB, 200 data records, 200 columns, 65,536 characters per cell. This tool intentionally rejects a full large feed; supply a small complete sample rather than a truncated byte prefix.
2. Identify actual header names from the file. Select them explicitly; no guessed image columns, automatic numeric-ID/SKU substitution, title matching or UPC fallback occurs.
3. From pe_site/server run, substituting the actual private file paths and exact headers:

   node scripts/inspect_csv_sample.mjs --input /private/feed-sample.csv --id-column 'ACTUAL ID HEADER' --image-column 'ACTUAL IMAGE HEADER'

   For an independently obtained local reference sample, append:

   --reference /private/reference-sample.csv --reference-id-column 'ACTUAL REFERENCE ID HEADER'

   Repeat --image-column for separate image columns. A cell containing a gallery-encoded list will not be split on guessed delimiters. Inspect its documented format after a real sample is supplied.
4. Inspect the sanitized report: record numbers, exact/absent/ambiguous matches, missing IDs and per-image URL syntax statuses. Reports contain no raw identifiers, image URLs, signed queries, prices or descriptions. Matching is case-sensitive and preserves leading zeros and whitespace; duplicates are quarantined. The report only applies to the supplied sample; uniqueness outside it is unknown.
5. HTTPS syntax is not accessibility. Once the real sample and legitimate image hostname are known, use at most a few authorized HTTPS image checks with redirects/credential forwarding disabled and bounded responses. Do not probe arbitrary URLs from CSVs, automatically load images, infer a secure feed from a secure image, or mark images accessible from synthetic fixtures. No image network-check facility is enabled by this patch.

## Scope and verification

Added files only: the standalone CSV inspection module, CLI, synthetic tests and this document. No route, admin markup, storefront file, database schema, package manifest, inventory or transaction code changes. No runtime import references the new module; no startup action or production configuration change is required. Leave the draft PR unmerged until reviewed; it can also be tested locally without a production deployment.

Tests cover strict quoted/multiline CSV, encoding, malformed headers/rows, resource limits, exact string identity matching, duplicate/missing/ambiguous identifiers, separate image columns, HTTPS URL rejection rules, no-fetch behavior, sensitive-cell redaction and CLI no-mutation/error behavior. Actual supplier image availability and accessibility are not yet verified.
