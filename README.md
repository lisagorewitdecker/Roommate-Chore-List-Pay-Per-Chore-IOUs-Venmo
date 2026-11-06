# Roommate Chore List - Pay Per Chore, IOUs & Venmo

A Vue 3 frontend, Express API, and PostgreSQL database for household chores,
cleaning supplies, shared expenses, and IOUs, with optional Gemini suggestions.

## Runtime and setup

The current frontend and matching API both live in `client/`. Root npm scripts
delegate there. The older `server/src` implementation and Knex schema are not
compatible with the current frontend; do not use them to run this application.

Use Node.js matching `^22.22.2 || ^24.15.0 || >=26.0.0` and Docker Compose.
From the repository root:

```bash
npm ci --prefix client
cp client/.env.example client/.env
docker compose up -d postgres
```

Set a unique, random `JWT_SECRET` in `client/.env`. The example database URL
matches the local-only PostgreSQL credentials in `docker-compose.yml`; use
separate credentials in production. Wait until PostgreSQL is healthy:

```bash
docker compose ps
```

Initialize a **new, empty** development database:

```bash
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U roommate_user -d roommate_chore_db < client/database/schema.sql
```

For an existing current-application database, apply every SQL file in
`client/database/migrations/` in filename order instead. Do not initialize the
current application with the legacy Knex migrations.

Start the API and frontend in separate terminals:

```bash
npm run dev:api
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to port 3000. Register a new
account to create a household, then share the home page's invite code so other
roommates can join. No demo accounts are created by the current schema.

For a single-origin deployment:

```bash
npm run build
npm start
```

The Express server serves the frontend and API on port 3000 (or `PORT`), including
direct navigation to frontend routes. Configure `CLIENT_ORIGIN` as the public
application URL. Production PostgreSQL connections verify TLS certificates;
`DATABASE_CA_CERT` can supply a provider-specific CA.

## Chores, supplies, and payment flow

Post a chore for another roommate to pick up, or assign it to yourself. Only its
assignee can complete it. Completion atomically records each other household
member's share as a pending IOU, excluding the worker's own share. Supply purchases
similarly create shared or beneficiary-specific IOUs using the actual paid cost.
All monetary amounts are stored as integer cents.

The Ledger shows pending debts and separate legacy wallet payment history.
Only an IOU's creditor can confirm receipt; confirmation does not transfer funds.
An IOU-backed chore cannot also be charged through the legacy wallet endpoint.

**Venmo is a manual handoff, not an integrated payment API.** Save your Venmo
username in the Ledger so debtors can open your profile with payment context.
They must review and send the payment in Venmo, and you must confirm receipt in
the Ledger. Opening the link does not verify or settle a payment automatically.
There is no Venmo OAuth, webhook, or automatic transfer verification.

## Gemini and password recovery

Set `GEMINI_API_KEY` in `client/.env` to enable price estimates, chore suggestions,
and fairness analysis. `GEMINI_MODEL` overrides the model; select a model
available to your Google project. The configured default is `gemini-3.8-flash`;
its live availability must be checked with your provider credentials.

AI requests require explicit user consent before sending chore context to Google.
Manual pricing and chore management work without Gemini. Provider requests time
out after 30 seconds; configuration, provider, and invalid-output errors are
shown rather than replaced with invented estimates.

Password recovery requires the `SMTP_*` settings and `CLIENT_ORIGIN`.
See [client/README.md](client/README.md) for API contracts, consent details, TLS,
and configuration instructions.

## Validation

```bash
npm run test:unit
npm test
npm run build
```

`npm test` requires PostgreSQL. Local test defaults target a separate
`roommate_test_db`; the runner creates it and initializes its schema. Override
`TEST_DATABASE_URL` for another disposable database containing a standalone
`test` segment in its name. Tests refuse to target the configured development
database. Integration fixtures exercise actual SQL transactions and rollback.
Gemini tests use controlled provider responses, not live API calls, and Venmo
tests do not move real money.
