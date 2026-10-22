# Chattanooga inventory ZIP mapping — 2026-10-22

Source: dealer-provided `itemInventory(1).zip` containing `itemInventory.csv` (Windows-1252/CP1252 encoded). The source inventory file is intentionally **not committed**: it contains wholesale prices, stock and product descriptions.

## Verified columns
`CSSI Item Number`, `Manufacturer`, `Manufacturer Item Number`, `Item Description`, `Qty On Hand`, `UPC Code`, `Item Weight`, `Price`, `MSRP`, `Web Item Name`, `Web Item Description`, `Category`, `Retail MAP`.

The CSV contains **no product image URL column**. The API `/items` response for `TX1GX293110EN1` likewise contains no category or image fields. Use the CSV category for classification and the API for a fresh price/quantity check, without assuming availability is reserved.

## Safe classification seed

A conservative local extraction of exact categories and pipe-separated category components produced **11,092 unique supplier SKUs** (8,776 firearms and 2,316 optics). The initial allowlist:
- Firearms: `Handguns`, `Rifles`, `Shotguns`
- Optics: `Centerfire Scopes`, `Reflex`, `Thermal Rifle Scopes`, `Rimfire Scopes`, `Spotting Scopes`, `Binoculars`, `Rangefinders`

The allowlist is deliberately incomplete and should be manually audited, especially for category combinations, serialized items, optics that require additional restrictions, duplicates, and category changes. Never use a loose substring match like `rifle` to import magazines or ammunition.

## Matched sample

- `TX1GX293110EN1`: `Handguns`; full name `Taurus GX2 Eagle Handgun 9mm Luger 10rd Magazines (2) 3.38" Barrel Black Slide/Eagle Grip`; `Price` 224.99; `Qty On Hand` 11; `Retail MAP` empty. Dealer screenshot independently matched these values.
- API abbreviated name: `Taurus GX2 9MM 3.38" 2x10RDS BK EAGLE EN1`; API reports 11 units; no category or image fields.

## Import plan (not yet enabled)

1. Upload the **SKU/category-only reference** through a manager-authenticated, size-limited, validated endpoint into a separate classification table. Do not store raw CSV HTML as executable content.
2. Match exact `CSSI Item Number` to API `cssi_id`; do not trust arbitrary browser-provided classifications.
3. Use supplier API for fresh costs, MAP and availability checks; treat zero/missing/invalid values as blocking publication.
4. Stage as draft only, with manual approval required per SKU. Do not auto-publish or auto-order.
5. Source images separately with permission. Verify Fortis, FFL and dropship workflows before any live sale.

**Current state:** No bulk import, auto-publishing, supplier order placement or customer-facing checkout has been enabled by this analysis.
