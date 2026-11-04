CREATE TABLE IF NOT EXISTS cleaning_supplies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  quantity VARCHAR(100),
  price_cents INT CHECK (price_cents IS NULL OR price_cents >= 0),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  beneficiary_id UUID REFERENCES users(id) ON DELETE SET NULL,
  purchased_by UUID REFERENCES users(id) ON DELETE SET NULL,
  actual_price_cents INT,
  purchased_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cleaning_supplies_active
  ON cleaning_supplies(household_id, purchased_at, created_at);
