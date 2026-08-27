# Pink Elephant production backend foundation

This is the next step beyond the browser-local prototype. It provides a hosted API shape for inventory, sales, users/roles and audit logging using PostgreSQL.

## Before production
1. Provision managed PostgreSQL and run `schema.sql`.
2. Create the first admin user with a one-time bootstrap script or secure migration (do not commit a password).
3. Set a long random `JWT_SECRET`, `DATABASE_URL`, and exact `CORS_ORIGIN`.
4. Put the API behind HTTPS and a reverse proxy/WAF.
5. Store product images in object storage rather than database blobs.
6. Add automated encrypted backups and restore testing.
7. Connect the admin UI to these API endpoints and remove localStorage for production records.
8. Add MFA/SSO for staff before launch.
9. Keep regulated-product checkout/transfer decisions behind explicit compliance rules and staff verification; this API does not determine legal eligibility or authorize firearm transfers.
10. Only connect an online payment processor after its written approval covers the store's actual products and transaction flow.

## Roles
- `admin`: full access, including audit log.
- `manager`: inventory and sales operations.
- `viewer`: read-only inventory.

## Security included
- Helmet security headers
- Login rate limiting
- JWT authentication with expiry
- Role-based authorization
- Parameterized SQL queries
- Inventory row locking during sale creation
- Audit log foundation
- Public inventory endpoint exposes only public fields
