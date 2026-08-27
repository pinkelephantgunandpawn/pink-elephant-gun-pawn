PINK ELEPHANT GUN & PAWN — PROFESSIONAL SITE FOUNDATION

This version removes the pawn workflow from the customer-facing options and keeps the site focused on buying, selling, trading, inventory and contact.

NEW ADMIN FOUNDATION
- Quantity-based inventory (example: 30 boxes of one product in a single listing)
- Cost field is admin-only
- Sale price, SKU, low-stock threshold and item type
- Individual vs quantity inventory model
- Automatic hiding of zero-quantity inventory on the public website
- Sales history with gross, tax, cost, profit and payment method
- Trends page with gross sales, transactions, units sold and manually entered foot traffic
- Admin settings area showing processor-independent payment architecture

IMPORTANT PRODUCTION NOTE
This is still a local prototype: data is stored in browser localStorage. It is NOT yet a production cloud system and should not be used for real customer, payment, tax or firearm transaction records. The next engineering step is a secure hosted database/API with authentication, role permissions, audit logs, backups, payment webhooks and the appropriate compliance controls.

PAYMENTS
PayPal is not configured for firearms/ammunition. Production checkout should use a payment provider/merchant account that has explicitly approved the store's products and sales model. The architecture is intentionally processor-independent.


SITE UPDATE — NEXT FOUNDATION STEP
- Added a dedicated Firearm Purchases information section.
- Added eligibility/ID/transfer language without treating an online listing as a completed regulated transaction.
- Added official store marketplace links for eBay, Reverb and Facebook.
- Kept the customer-facing site free of the removed “Tell Us What You've Got” and Pokémon sections.
- Kept the prototype processor-independent; payment and regulated transaction workflows remain to be connected to a secure production backend.

PRODUCTION BACKEND FOUNDATION — ADDED
- PostgreSQL schema for users, roles, inventory, sales, foot traffic and audit logs.
- Express API with JWT authentication, role-based authorization, rate limiting, security headers and parameterized queries.
- Inventory sales use row locking so two simultaneous sales cannot oversell the same quantity.
- Public inventory endpoint exposes only public listing fields.
- Audit log records staff actions.
- Docker Compose and environment template included for deployment.
- This is an engineering foundation, not a legal/compliance determination system. Regulated-item eligibility, transfer and payment-provider approval must be verified before production use.


ADMIN/API CONNECTION — COMPLETED
- Admin Portal now authenticates against the Express API with JWT sessions.
- Inventory create/update/delete, sales recording and foot-traffic entries use PostgreSQL through the API.
- Public website inventory loads from /api/public/inventory instead of browser localStorage.
- Bootstrap admin credentials are configured through ADMIN_EMAIL and ADMIN_PASSWORD environment variables.
- Frontend defaults to http://localhost:8080 for the API and can be overridden with window.PE_API_BASE.
- Image upload was replaced in the database-connected admin form with a hosted Image URL field so the API never stores arbitrary base64 blobs.
