ALTER TABLE users ADD COLUMN IF NOT EXISTS venmo_username VARCHAR(30);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_venmo_username_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_venmo_username_check
      CHECK (venmo_username IS NULL OR venmo_username ~ '^[A-Za-z0-9_-]{1,30}$');
  END IF;
END $$;

ALTER TABLE chores ADD COLUMN IF NOT EXISTS settlement_type VARCHAR(20) NOT NULL DEFAULT 'wallet';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chores_settlement_type_check') THEN
    ALTER TABLE chores ADD CONSTRAINT chores_settlement_type_check
      CHECK (settlement_type IN ('wallet', 'household_iou'));
  END IF;
END $$;

ALTER TABLE cleaning_supplies ADD COLUMN IF NOT EXISTS beneficiary_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cleaning_supplies ADD COLUMN IF NOT EXISTS purchased_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cleaning_supplies ADD COLUMN IF NOT EXISTS actual_price_cents INT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cleaning_supplies_actual_price_cents_check') THEN
    ALTER TABLE cleaning_supplies ADD CONSTRAINT cleaning_supplies_actual_price_cents_check
      CHECK (actual_price_cents IS NULL OR actual_price_cents >= 0);
  END IF;
END $$;

ALTER TABLE ious ADD COLUMN IF NOT EXISTS source_chore_id UUID REFERENCES chores(id) ON DELETE SET NULL;
ALTER TABLE ious ADD COLUMN IF NOT EXISTS source_supply_id UUID;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ious_source_supply_id_fkey') THEN
    ALTER TABLE ious ADD CONSTRAINT ious_source_supply_id_fkey
      FOREIGN KEY (source_supply_id) REFERENCES cleaning_supplies(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ious_single_expense_source_check') THEN
    ALTER TABLE ious ADD CONSTRAINT ious_single_expense_source_check
      CHECK (source_chore_id IS NULL OR source_supply_id IS NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ious_source_chore_debtor
  ON ious(source_chore_id, debtor_id) WHERE source_chore_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ious_source_supply_debtor
  ON ious(source_supply_id, debtor_id) WHERE source_supply_id IS NOT NULL;