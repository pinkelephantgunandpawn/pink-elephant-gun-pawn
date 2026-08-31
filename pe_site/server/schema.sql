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
