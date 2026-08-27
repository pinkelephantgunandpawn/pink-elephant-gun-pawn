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
