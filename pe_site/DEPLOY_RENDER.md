# Pink Elephant — Render deployment

This package is prepared for a Render Web Service + Render Postgres deployment.

1. Put this folder in a GitHub repository.
2. In Render, create a Blueprint and select the repository. The included render.yaml creates the web service and Postgres database.
3. Set ADMIN_EMAIL and a strong ADMIN_PASSWORD (12+ characters).
4. Deploy.
5. Add `pinkelephantgunandpawn.com` as the custom domain on the web service. Render will provide the DNS target.
6. Add the required DNS record(s) in Cloudflare exactly as Render specifies.

The frontend now uses the same origin for `/api/*`, so no localhost API URL is used in production.
