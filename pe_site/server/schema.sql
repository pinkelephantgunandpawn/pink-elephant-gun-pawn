CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','manager','viewer')) DEFAULT 'viewer',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  price_cents integer,
  price_label text,
  sku text UNIQUE,
  item_type text NOT NULL CHECK (item_type IN ('quantity','individual')),
  low_stock integer NOT NULL DEFAULT 5 CHECK (low_stock >= 0),
  description text NOT NULL DEFAULT '',
  image_url text,
  regulated boolean NOT NULL DEFAULT false,
  public_visible boolean NOT NULL DEFAULT true,
  shipping_weight_lb numeric(10,3),
  shipping_length_in numeric(10,2),
  shipping_width_in numeric(10,2),
  shipping_height_in numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id uuid REFERENCES inventory(id) ON DELETE SET NULL,
  item_title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  gross_cents integer NOT NULL CHECK (gross_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  payment_method text NOT NULL,
  order_ref text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS foot_traffic (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  traffic_date date UNIQUE NOT NULL,
  visitors integer NOT NULL CHECK (visitors >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inventory_public_idx ON inventory(public_visible, quantity);
CREATE INDEX IF NOT EXISTS sales_created_idx ON sales(created_at);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at);


CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text UNIQUE NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text NOT NULL,
  fulfillment text NOT NULL CHECK (fulfillment IN ('pickup','shipping')),
  shipping_address jsonb,
  notes text NOT NULL DEFAULT '',
  subtotal_cents integer NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents integer NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  shipping_cents integer NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  payment_status text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','refunded','cancelled')),
  order_status text NOT NULL DEFAULT 'new' CHECK (order_status IN ('new','confirmed','ready','shipped','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  inventory_id uuid REFERENCES inventory(id) ON DELETE SET NULL,
  item_title text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents integer NOT NULL CHECK (line_total_cents >= 0)
);

CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);


-- OVERHAUL INVENTORY FIELDS
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'Good';
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS sale_price_cents integer;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS image_urls jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ORDER MANAGEMENT FIELDS
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes text NOT NULL DEFAULT '';

-- FIREARM / REGULATED ITEM REQUESTS
CREATE TABLE IF NOT EXISTS ffl_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number text UNIQUE NOT NULL,
  inventory_id uuid REFERENCES inventory(id) ON DELETE SET NULL,
  item_title text NOT NULL,
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text NOT NULL,
  request_type text NOT NULL CHECK (request_type IN ('store_pickup','ffl_transfer')),
  destination_state text,
  receiving_ffl_name text,
  receiving_ffl_phone text,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','awaiting_ffl','ready','completed','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ffl_requests_created_idx ON ffl_requests(created_at);


-- PROFESSIONAL FIREARM CHECKOUT / FFL DIRECTORY
CREATE TABLE IF NOT EXISTS ffl_dealers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address1 text NOT NULL,
  city text NOT NULL,
  state text NOT NULL,
  postal text NOT NULL,
  phone text,
  email text,
  license_on_file boolean NOT NULL DEFAULT false,
  preferred boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  latitude numeric,
  longitude numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ffl_dealers_search_idx ON ffl_dealers(active,state,postal);

ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS dealer_id uuid REFERENCES ffl_dealers(id) ON DELETE SET NULL;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS dealer_snapshot jsonb;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS customer_address jsonb;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS shipping_method text NOT NULL DEFAULT 'store_review';
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'pending_review';
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS quoted_total_cents integer;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS age_certified boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS inventory_restocked boolean NOT NULL DEFAULT false;


-- BATCH INVENTORY INTAKE / REVIEW QUEUE
CREATE TABLE IF NOT EXISTS batch_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review','published')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES batch_uploads(id) ON DELETE CASCADE,
  inventory_id uuid REFERENCES inventory(id) ON DELETE SET NULL,
  filename text NOT NULL DEFAULT 'photo.jpg',
  image_data text NOT NULL,
  title text NOT NULL DEFAULT '',
  suggested_title text,
  category text NOT NULL DEFAULT 'Other',
  condition text NOT NULL DEFAULT 'Good',
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  price_cents integer,
  suggested_price_cents integer,
  market_low_cents integer,
  market_high_cents integer,
  confidence numeric,
  source_label text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','analyzed','reviewed','published','error')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batch_items_batch_idx ON batch_items(batch_id,created_at);


-- SHIPPO SHIPPING RATE / FULFILLMENT FOUNDATION
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shippo_rate_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shippo_shipment_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_provider text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_service text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shippo_transaction_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_label_url text;


-- Shipping package fields for Shippo live-rate quoting
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shipping_weight_lb numeric(10,3);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shipping_length_in numeric(10,2);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shipping_width_in numeric(10,2);
ALTER TABLE inventory ADD COLUMN IF NOT EXISTS shipping_height_in numeric(10,2);


-- PRE-MERCHANT LAUNCH READINESS: TAX / LABEL / EMAIL / FULFILLMENT
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_label_test boolean;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS label_created_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shippo_refund_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shippo_refund_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email_sent_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email_error text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;


-- Customer portal accounts
CREATE TABLE IF NOT EXISTS customers (
  id bigserial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id bigint REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);


-- QoL / customer portal / admin archive additions
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_hidden boolean NOT NULL DEFAULT false;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS address1 text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address2 text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bravo_customer_id text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bravo_link_status text NOT NULL DEFAULT 'not_connected';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bravo_last_synced_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_orders_admin_hidden ON orders(admin_hidden);


-- MAKE OFFER WORKFLOW
CREATE TABLE IF NOT EXISTS offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id uuid REFERENCES inventory(id) ON DELETE SET NULL,
  item_title text NOT NULL,
  asking_price_cents integer,
  offer_cents integer NOT NULL CHECK (offer_cents >= 0),
  customer_name text NOT NULL,
  customer_email text NOT NULL,
  customer_phone text,
  customer_message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','accepted','countered','declined','expired')),
  counter_cents integer,
  admin_notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offers_created_idx ON offers(created_at DESC);
CREATE INDEX IF NOT EXISTS offers_status_idx ON offers(status,created_at DESC);

-- CUSTOMER EXPERIENCE / STATUS EMAILS
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_status_email text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_status_email_at timestamptz;


-- FIREARM CHECKOUT COMPLIANCE GATE
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS buyer_date_of_birth date;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS buyer_residence_state text;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS state_law_reviewed boolean NOT NULL DEFAULT false;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS age_reviewed boolean NOT NULL DEFAULT false;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS identity_reviewed boolean NOT NULL DEFAULT false;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS ffl_verified boolean NOT NULL DEFAULT false;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS release_approved boolean NOT NULL DEFAULT false;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS compliance_status text NOT NULL DEFAULT 'hold';
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS compliance_notes text NOT NULL DEFAULT '';
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS compliance_reviewed_at timestamptz;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS compliance_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS receiving_ffl_number text;
ALTER TABLE ffl_requests ADD COLUMN IF NOT EXISTS receiving_ffl_license_type text;

CREATE TABLE IF NOT EXISTS state_law_profiles (
  state_code text PRIMARY KEY,
  state_name text NOT NULL,
  review_level text NOT NULL DEFAULT 'manual_review',
  summary text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT 'https://www.atf.gov/firearms/tools-and-services-firearms-industry/state-laws-and-published-ordinances-firearms',
  internal_notes text NOT NULL DEFAULT '',
  last_verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);


-- YEAR-END SALES / TAX REPORTING SNAPSHOTS
-- Store the jurisdiction/rate used at checkout so future reports do not have to infer current tax settings.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_state text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_rate_bps_snapshot integer;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_tax_cents integer NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at timestamptz;
CREATE INDEX IF NOT EXISTS orders_tax_year_idx ON orders(created_at,payment_status);

-- OFFICIAL ATF FFL DIRECTORY IMPORT / LOCATOR
ALTER TABLE ffl_dealers ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'MANUAL';
ALTER TABLE ffl_dealers ADD COLUMN IF NOT EXISTS source_license_number text;
ALTER TABLE ffl_dealers ADD COLUMN IF NOT EXISTS license_type text;
ALTER TABLE ffl_dealers ADD COLUMN IF NOT EXISTS source_updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ffl_dealers_source_identity_idx ON ffl_dealers(source,name,address1,city,state,postal);
CREATE INDEX IF NOT EXISTS ffl_dealers_geo_idx ON ffl_dealers(active,latitude,longitude);
CREATE INDEX IF NOT EXISTS ffl_dealers_postal_idx ON ffl_dealers(active,postal);
