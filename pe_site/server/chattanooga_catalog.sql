-- Chattanooga distributor catalog staging. Safe to apply repeatedly.
-- Draft rows never become visible in storefront inventory automatically.
CREATE TABLE IF NOT EXISTS distributor_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier text NOT NULL DEFAULT 'chattanooga' CHECK (supplier = 'chattanooga'),
  supplier_item_id text NOT NULL,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'Uncategorized',
  brand text,
  sku text,
  upc text,
  description text NOT NULL DEFAULT '',
  image_url text,
  cost_cents integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  available_quantity integer NOT NULL DEFAULT 0 CHECK (available_quantity >= 0),
  markup_percent numeric(8,3) NOT NULL DEFAULT 20 CHECK (markup_percent >= 0),
  price_override_cents integer CHECK (price_override_cents >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden')),
  inventory_id uuid UNIQUE REFERENCES inventory(id) ON DELETE SET NULL,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier, supplier_item_id)
);
CREATE INDEX IF NOT EXISTS distributor_catalog_category_status_idx ON distributor_catalog(category,status);
CREATE INDEX IF NOT EXISTS distributor_catalog_supplier_sku_idx ON distributor_catalog(supplier,sku);
-- Retail price is rounded to nearest cent. Manual override takes priority.

ALTER TABLE distributor_catalog ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending';
ALTER TABLE distributor_catalog ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- Dealer-provided CSV reference only. This table is NOT storefront inventory.
CREATE TABLE IF NOT EXISTS chattanooga_reference (
  supplier_item_id text PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('Firearms','Optics')),
  supplier_category text NOT NULL DEFAULT '',
  reference_title text NOT NULL DEFAULT '',
  manufacturer text NOT NULL DEFAULT '',
  upc text NOT NULL DEFAULT '',
  map_cents integer CHECK (map_cents >= 0),
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chattanooga_reference_category_idx ON chattanooga_reference(category);

ALTER TABLE distributor_catalog ADD COLUMN IF NOT EXISTS map_cents integer CHECK (map_cents >= 0);
