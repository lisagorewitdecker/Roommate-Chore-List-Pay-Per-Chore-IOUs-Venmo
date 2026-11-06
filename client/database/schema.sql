-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Households (groups roommates together)
CREATE TABLE households (
                            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                            name VARCHAR(100) NOT NULL,
                            invite_code VARCHAR(12) UNIQUE NOT NULL,
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Users & Balances
CREATE TABLE users (
                       id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                       household_id UUID REFERENCES households(id) ON DELETE SET NULL,
                       name VARCHAR(100) NOT NULL,
                       email VARCHAR(255) NOT NULL,
                       password_hash VARCHAR(255) NOT NULL,
                       session_version INT NOT NULL DEFAULT 0,
                       password_reset_token_hash CHAR(64),
                       password_reset_token_expires_at TIMESTAMP WITH TIME ZONE,
                       balance_cents INT NOT NULL DEFAULT 0, -- Stored in cents ($10.50 = 1050)
                       venmo_username VARCHAR(30) CHECK (venmo_username IS NULL OR venmo_username ~ '^[A-Za-z0-9_-]{1,30}$'),
                       created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (LOWER(email));
CREATE INDEX idx_users_password_reset_token_hash
  ON users(password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL;

-- Chores (Full CRUD target)
CREATE TYPE chore_status AS ENUM ('open', 'in_progress', 'completed', 'verified_paid');

CREATE TABLE chores (
                        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                        household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
                        title VARCHAR(150) NOT NULL,
                        description TEXT,
                        price_cents INT NOT NULL CHECK (price_cents >= 0),
                        created_by UUID NOT NULL REFERENCES users(id),
                        assigned_to UUID REFERENCES users(id),
                        settlement_type VARCHAR(20) NOT NULL DEFAULT 'wallet' CHECK (settlement_type IN ('wallet', 'household_iou')),
                        status chore_status DEFAULT 'open',
                        ai_suggested BOOLEAN DEFAULT FALSE,
                        due_date DATE,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ledger / Transactions (Venmo Payout Audit Trail)
CREATE TABLE transactions (
                              id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                              chore_id UUID REFERENCES chores(id) ON DELETE SET NULL,
                              payer_id UUID NOT NULL REFERENCES users(id),
                              payee_id UUID NOT NULL REFERENCES users(id),
                              amount_cents INT NOT NULL CHECK (amount_cents > 0),
                              note VARCHAR(255),
                              created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ious (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  debtor_id UUID NOT NULL REFERENCES users(id),
  creditor_id UUID NOT NULL REFERENCES users(id),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  description VARCHAR(255),
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP WITH TIME ZONE,
  source_chore_id UUID REFERENCES chores(id) ON DELETE SET NULL,
  source_supply_id UUID,
  CHECK (debtor_id <> creditor_id),
  CHECK (created_by = debtor_id OR created_by = creditor_id),
  CHECK ((status = 'pending' AND settled_at IS NULL) OR (status = 'paid' AND settled_at IS NOT NULL)),
  CONSTRAINT ious_single_expense_source_check CHECK (source_chore_id IS NULL OR source_supply_id IS NULL)
);

-- Indexes for performant foreign key queries
CREATE INDEX idx_chores_household ON chores(household_id);
CREATE INDEX idx_chores_assignee ON chores(assigned_to);
CREATE INDEX idx_transactions_users ON transactions(payer_id, payee_id);
CREATE INDEX idx_ious_household_status ON ious(household_id, status, created_at DESC);
CREATE INDEX idx_ious_participants ON ious(debtor_id, creditor_id);
CREATE UNIQUE INDEX idx_ious_source_chore_debtor ON ious(source_chore_id, debtor_id) WHERE source_chore_id IS NOT NULL;
CREATE UNIQUE INDEX idx_ious_source_supply_debtor ON ious(source_supply_id, debtor_id) WHERE source_supply_id IS NOT NULL;

-- Active household cleaning supplies; purchase records leave the active list.
CREATE TABLE cleaning_supplies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  quantity VARCHAR(100),
  price_cents INT CHECK (price_cents IS NULL OR price_cents >= 0),
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  beneficiary_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  purchased_by UUID REFERENCES users(id) ON DELETE SET NULL,
  actual_price_cents INT CHECK (actual_price_cents IS NULL OR actual_price_cents >= 0),
  purchased_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ious ADD CONSTRAINT ious_source_supply_id_fkey
  FOREIGN KEY (source_supply_id) REFERENCES cleaning_supplies(id) ON DELETE SET NULL;

CREATE INDEX idx_cleaning_supplies_active ON cleaning_supplies(household_id, purchased_at, created_at);