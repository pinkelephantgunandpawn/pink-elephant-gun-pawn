# Chattanooga CSV reference import (October 2026)

## Purpose
The dealer-provided `itemInventory.csv` export contains supplier categories missing from the V6 `/items` API. Use a **filtered reference CSV** with the exact columns:

`CSSI Item Number,Product Type,Supplier Category,Web Item Name,Manufacturer,UPC Code,Retail MAP`

Only `Product Type` values `Firearms` or `Optics` are accepted. The filtered reference from this ChatGPT session contains 11,092 unique supplier SKUs (8,776 firearms and 2,316 optics), using a conservative list of clearly identified categories. No wholesale costs or supplier stock are imported from this file.

## How to use
1. Sign in as manager and visit `/chattanooga.html`.
2. Under **Import supplier reference CSV**, choose `chattanooga_firearms_optics_reference.csv`.
3. Click **Import reference**, then **Check reference count**.
4. Use **Preview SKU** to retrieve an exact supplier SKU through the live API; the reference table provides category and MAP fallback.
5. Select eligible previewed products and **Add selected to drafts**, then review and approve each individually.

## Safety properties
- The reference upload replaces only `chattanooga_reference` rows in a transaction. It never stages, approves, publishes, creates storefront inventory, or orders products.
- Upload is behind the existing manager authentication middleware; CSV only, maximum 5 MiB and 20,000 rows, strict schema, unique validated item IDs, only Firearms/Optics categories.
- Supplier API still supplies dealer cost and reported quantity for any draft; quantities are **not** reservations.
- MAP is retained for staged drafts and price previews use the higher of 20% markup and MAP. Final MAP semantics and checkout enforcement are **not verified**.
- Restaging or refreshing a draft resets individual approval to pending.
- Existing out-of-scope drafts remain unpublished. Supplier publication and ordering remain disabled.

## Remaining blockers
- Confirm which product-feed fields or separately licensed source contains authorized product images.
- Confirm supplier MAP/UPP rules and cost semantics, including missing or zero MAP.
- Confirm real-time allocation, account dropship authorization, restrictions and shipping terms.
- Verify Fortis payment and firearm FFL checkout end to end.
- Perform security and functional testing before enabling any public supplier listing.
