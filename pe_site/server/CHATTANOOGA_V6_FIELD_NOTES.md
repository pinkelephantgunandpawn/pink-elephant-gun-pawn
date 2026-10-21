# Chattanooga Shooting Supplies REST V6 — verified integration notes

**Status:** Development branch only. No automatic catalog import, publishing, inventory update, or supplier ordering should be enabled on the basis of these observations.

## Verified read-only connectivity
- `GET https://api.chattanoogashooting.com/rest/v6/items?page=1&per_page=1` succeeded in an isolated test service using Render-managed credentials.
- The successful response was an object containing `pagination` and `items`.
- `GET /items/product-feed?page=1&per_page=1` returned HTTP 422 with supplier error code 9000. This does **not** establish that the endpoint is unsupported: its required parameters or permitted use are still unknown.
- Credentials are environment variables `CHATTANOOGA_SID` and `CHATTANOOGA_TOKEN`. Never commit or display their values.

## Fields observed in an `items` record

| Field | Observed type | Safe interpretation |
| --- | --- | --- |
| `cssi_id` | string | Supplier record identifier candidate |
| `name` | string | Product name |
| `custom_price` | number | Price candidate; **dealer-cost meaning not verified** |
| `inventory` | number | Inventory quantity field; allocation/availability semantics unverified |
| `map_price` | string | MAP-related value; exact supplier semantics unverified |
| `retail_map_price` | string | Retail MAP-related value; exact supplier semantics unverified |
| `drop_ship_price` | number | Drop-ship price field; terms unverified |
| `retail_price` | number | Retail price field; terms unverified |
| `available_allocated_quantity` | number | Allocation quantity field; availability semantics unverified |
| `serialized_flag` | number | Supplier flag; enumeration and implications unverified |
| `in_stock_flag` | number | Supplier flag; enumeration and implications unverified |
| `drop_ship_flag` | number | Supplier flag; enumeration and implications unverified |

Do not interpret a numeric supplier flag as a Boolean without confirming its allowed values. Do not infer sellable stock from a single quantity field without supplier confirmation.

## Current code risks to address before any import
- `chattanooga_routes.js` currently looks for generic `item_id`, `cost`, and `quantity_available` field names, which do not match the verified V6 sample.
- The existing `remote` catalog normalization therefore cannot be relied upon to show accurate product previews.
- The existing stage, sync, and publish routes are **not production-approved**. This file's purpose is documentation, not authorization to activate those routes.
- The read-only `chattanooga_inspect.js` deliberately returns `safe_to_import: false` and `price_meaning_verified: false`.
- The isolated `chattanooga_probe.js` reports field-validity booleans and field names/types, not supplier product values. The test service has auto-deploy disabled.

## Next verification questions for Chattanooga
1. Is `custom_price` the dealer's actual purchase cost for this account? If not, which field is?
2. Which of `map_price` and `retail_map_price` governs the retailer's advertised selling price, and how should zero or missing values be handled?
3. Does `inventory` represent available-to-order quantity, or should `available_allocated_quantity` and `in_stock_flag` be considered?
4. Which field provides the canonical manufacturer SKU, UPC, image URLs, category, and regulated-product classification?
5. What request parameters are required for `/items/product-feed`, and what does supplier error 9000 indicate?

**Release rule:** Keep the main branch and production deployment unchanged until pricing semantics, classification, inventory availability, authorization, and business approval are verified.
