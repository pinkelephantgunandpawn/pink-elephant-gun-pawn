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

## Dealer portal visual cross-checks (October 21, 2026)
These values are from dealer portal screenshots, **not** direct API responses. Do not assume any one API field maps to a portal label without matching the same product.

| Portal product | Item number | UPC | Dealer portal price | Retail MAP | Portal stock |
| --- | --- | --- | --- | --- | --- |
| Sig Sauer Romeo5 Gen II Compact Red Dot | `XISOR5101` | `798681694600` | $113.88 sale ($119.99 struck through) | dash / not provided | 32 |
| ZeroTech Thrive HD Digital Red Dot 1x22 2 MOA | `ZOTHRD22` | `9334046004687` | $95.99 sale ($97.19 struck through) | $149.00 | 9 |

A 20% markup on $95.99 is $115.19, below the portal's displayed $149.00 Retail MAP. The read-only `evaluateMapPrice` helper suggests $149.00 in that example; do not apply this to storefront pricing until MAP semantics and API cost mapping are confirmed.

The read-only inspector now distinguishes a missing MAP value (null, absent, empty, or dash) from an invalid/unrecognized MAP value. The live probe previously saw unrecognized MAP formats in its first sample; this alone does not establish that MAP is absent. It is not yet known how the API encodes a portal dash.

## Isolated API probe update (October 21, 2026)
- On the latest isolated Render test deployment, `GET /items?page=1&per_page=1` still succeeded.
- Both `map_price` and `retail_map_price` on **that sampled API record** were blank strings, not malformed prices. This does not establish the MAP format for all products.
- A subsequent automatic `GET /items/product-feed` request returned HTTP 429 with supplier error code `too-many-requests`. Earlier calls returned HTTP 422, code 9000.
- Automatic product-feed calls were disabled in `chattanooga_probe.js` to avoid repeated unsuccessful/rate-limited requests. Further testing of that endpoint requires supplier documentation or support guidance.
- The portal examples for the Romeo5 and ZeroTech products are not matched to this API sample; no dealer-price field mapping has been proven.

## Public third-party documentation research (October 21, 2026)

**These are leads, not first-party REST V6 field definitions or proof of account-specific pricing.**

- [Flxpoint: Chattanooga as a Source](https://support.flxpoint.com/en_US/firearm-tactical/chattanooga-as-a-source) documents mapping "Retail Price / Custom Price" to internal cost, with the choice depending on the integration configuration. It maps "Retail MAP Price" to MAP, and mentions quantity, SKU, UPC, manufacturer, descriptions and images. This supports `retail_map_price` as a **MAP candidate**, not a proven REST V6 mapping for this account. The portal's "Your Price" must still be cross-checked.
- [FirearmCart Chattanooga integration](https://docs.firearmcart.com/integrations/chattanooga/) says a Chattanooga dealer-account feed contains cost, MSRP, MAP, stock, UPC, imagery and specifications. It says product-feed requests can fail or time out; this does not explain the observed HTTP 422/429 errors or document endpoint parameters.
- [Chattanooga fulfillment agreement](https://form.jotform.com/223624916917059) states manufacturers' MAP and UPP must be followed, and warns that supplier stock displayed on a customer's website may be inaccurate. Do not automatically publish items or promise availability based solely on `inventory`.
- [MicroBiz Chattanooga credential instructions](https://cloudv2.microbizcloud.com/support/solutions/articles/9000272880-setting-up-vendor-credentials-in-pricecompare-firearm-vendor-distributor-feeds) confirms dealer-account SID and token and notes additional account authorization may be required for certain API ordering operations. This does not establish the cause of the product-feed HTTP errors.

**Open questions:** Does `custom_price` match the portal's current sale "Your Price" for the same SKU? Is `retail_map_price` exactly the portal's "Retail MAP" for the same SKU? What is the supplier's recommended available-to-sell quantity? What are the allowed feed request parameters and rate limits?

No production catalog mapping or automatic pricing changes should be made from these third-party descriptions alone.
