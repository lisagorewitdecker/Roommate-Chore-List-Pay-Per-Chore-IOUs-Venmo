CREATE TABLE IF NOT EXISTS ious (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  debtor_id UUID NOT NULL REFERENCES users(id),
  creditor_id UUID NOT NULL REFERENCES users(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  description VARCHAR(255),
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP WITH TIME ZONE,
  CHECK (debtor_id <> creditor_id),
  CHECK (created_by = debtor_id OR created_by = creditor_id),
  CHECK ((status = 'pending' AND settled_at IS NULL) OR (status = 'paid' AND settled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_ious_household_status ON ious(household_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ious_participants ON ious(debtor_id, creditor_id);
