# Roommate Chore Payments

## Payment API

The Express API exposes `POST /api/payments/pay-chore`. It requires a Bearer JWT signed with `JWT_SECRET` and a JSON body containing only the chore identifier:

```json
{ "chore_id": "<chore UUID>" }
```

The authenticated user's ID is read from the JWT, not from the request body. For legacy wallet-settled chores, the API locks the chore and both wallet rows, checks the chore state, household membership, positive price, and payer balance, then transfers the funds, marks the chore `verified_paid`, and inserts the audit transaction in one PostgreSQL transaction. Chores completed through the current workflow are split into household IOUs instead; the endpoint rejects a second wallet charge for those chores. Any failed wallet transfer rolls back.

## AI Pricing API

`POST /api/ai/estimate-price` requires a Bearer JWT signed with `JWT_SECRET` and a JSON body containing a non-empty `title` and an optional string `description`. It uses Gemini to return `price_cents`, `difficulty` (`Easy`, `Medium`, or `Hard`), and `reasoning`. The submitted `title` and `description` are sent to the external Gemini provider to generate the estimate. Configure `GEMINI_API_KEY` in the API server environment to enable estimates; the default model is `gemini-3.8-flash`, and `GEMINI_MODEL` can override it. Missing credentials and provider errors include configuration guidance without exposing the API key.

`POST /api/ai/fair-split` requires the same authentication and analyzes chore assignment counts and total prices for the signed-in user's current household. The API sends only anonymized aggregate counts and values to Gemini, not roommate names, email addresses, or chore descriptions. The returned score, observations, and recommendations are a limited snapshot of recorded assignments, not a definitive fairness judgment. At least one chore must be assigned to a household member.

`POST /api/ai/suggest-chores` requires the same authentication and suggests chores using up to 20 existing household chore titles and anonymized assigned chore counts per roommate. Chore titles are sent to Gemini and may contain personal information; names, email addresses, and descriptions are not sent. Suggestions include a proposed whole-cent cost and informational frequency; frequency is not saved as a recurring schedule. Households without existing chores can still request suggestions.

### AI data sharing and consent

AI endpoints cross a trust boundary to a third-party model provider (Gemini). Enable these routes only when your deployment and household policy explicitly allow third-party processing of user-provided chore text. Obtain informed user consent before use, and avoid submitting sensitive personal data in chore titles/descriptions. Operationally, treat AI features as opt-in (for example, behind an explicit deployment flag such as `AI_FEATURES_ENABLED=true`) and keep them disabled by default unless this consent and policy requirement is met.

## Chore API

- `GET /api/chores` lists the authenticated user's household chores.
- `POST /api/chores` creates a chore with `title`, optional `description`, integer `price_cents`, and optional `due_date` and same-household `assigned_to` UUID.
- `POST /api/chores/:id/offer` releases an open chore assigned to the signed-in roommate; `POST /api/chores/:id/claim` atomically assigns an offered chore to a different household member.
- `PATCH /api/chores/:id/complete` or `PATCH /api/chores/:id` with `{ "status": "completed" }` completes an open chore.
- `DELETE /api/chores/:id` removes only an open chore created by the authenticated user.

Only the assigned roommate can complete a chore. Completion records that roommate as the IOU creditor and divides the chore's price across all household members, including the worker's share; no self-IOU or second full-price wallet charge is created. All chore endpoints require authentication and determine household membership from the current database user record, not from potentially stale JWT household claims. Chore prices are stored in cents; no frequency field exists in the database schema.

## Cleaning Supplies

- `GET /api/supplies` returns active household supplies and household members for assignment.
- `POST /api/supplies` adds an item with `name`, optional `quantity`, optional expected integer `price_cents`, optional same-household `assigned_to` buyer, and optional same-household `beneficiary_id`.
- `PATCH /api/supplies/:id` updates `assigned_to`, `beneficiary_id`, and/or expected `price_cents`; use `null` to clear a buyer, beneficiary, or cost.
- `POST /api/supplies/:id/purchase` accepts the actual whole-cent cost as `actual_price_cents`, records who purchased it, and removes the item from the active list. If a buyer is assigned, only that roommate can complete the purchase.

The Supplies page supports shared household items or items assigned to one beneficiary, assigning buyers, entering the actual paid cost, and printing the active list. Shared costs are divided across all household members in stable ID order, with remainder cents assigned to the first members; the buyer's own share is not recorded as a self-IOU. An individual item charges its entire actual cost to that beneficiary, unless the buyer is also the beneficiary. Zero-cost purchases create no IOUs. Purchases create pending IOUs atomically and do not change wallet balances; purchased entries leave the active list and the same item can be added again later.

## Ledger and IOUs

- `GET /api/ledger` returns the signed-in roommate's wallet payment history, IOUs, and household members; `GET /api/ledger/summary` totals that roommate's pending IOUs.
- `POST /api/ledger/ious` records an IOU using `debtor_id`, `creditor_id`, positive integer `amount_cents`, and optional `description`. The signed-in user must be one of the two household members.
- `PATCH /api/ledger/venmo` saves the current user's Venmo username (send an empty value to clear it); `GET /api/ledger` returns the profile username and creditor usernames on IOUs.
- `PATCH /api/ledger/ious/:id/paid` lets only the creditor confirm an IOU as settled. Confirmation records the external payment; it does not transfer wallet funds or create a wallet transaction.

Completing an assigned chore creates source-linked, pending IOUs that divide its whole-cent price among the household, excluding the worker's own share. Those chore IOUs cannot also be paid through the legacy full-price wallet endpoint. The Ledger page offers a Venmo profile handoff link to debtors when the creditor has configured a username; the roommate must review and send the payment in Venmo, and the creditor must still confirm receipt in the ledger. Opening a link is not proof of transfer. Legacy wallet transfers remain separate and appear as payment history.

## Authentication API

- `POST /api/auth/register` accepts `name`, `email`, and `password`, with optional `household_name` and `invite_code`. A registration with an invite code joins that household; without one, it creates a household. Passwords must be at least 8 characters and no more than 72 UTF-8 bytes.
- `POST /api/auth/login` accepts `email` and `password` and returns a Bearer JWT and safe user data.
- `POST /api/auth/password-reset/request` accepts an email and sends a reset link when an account exists. It always returns the same success response for known and unknown addresses.
- `POST /api/auth/password-reset/complete` accepts the emailed `token` and a new `password`; reset links expire after one hour and can only be used once.
- `GET /api/auth/me` requires `Authorization: Bearer <token>` and returns the signed-in user's profile and household details.

Protected endpoints return `401` with `Missing or malformed token` when the authorization header is absent or malformed, and `403` with `Invalid or expired token` when JWT verification fails, including for expired tokens.

Passwords are hashed with bcrypt. Registration, household assignment, and user creation share one database transaction. Email uniqueness is enforced case-insensitively, including concurrent registrations.

Password recovery stores only a SHA-256 hash of each random reset token. Registration and login are each limited to five requests per client IP in a 15-minute window; password-reset request and completion share a five-request window. Rate-limited responses return `429` with `Retry-After` and standard `RateLimit-*` headers. The default in-memory counters are per API process and reset on restart, so multi-instance deployments need a shared rate-limit store; when behind a reverse proxy, configure Express to trust only the known proxy so the client IP is identified correctly. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` to deliver reset emails. `CLIENT_ORIGIN` is the fixed frontend origin used in email links; set it to the public frontend URL in production.

## Setup

1. Install dependencies with `npm ci`. Vite and its Vue plugin use compatible versions.
2. Create a PostgreSQL database and apply `database/schema.sql` to it. For existing installations, apply every SQL file in `database/migrations/` in filename order, including `001_users_email_case_insensitive.sql` and `005_session_version.sql`; the migrations are idempotent.
3. Configure `DATABASE_URL`, `JWT_SECRET`, and `GEMINI_API_KEY` in the server environment or in `client/.env`. To enable password recovery, also set the SMTP variables listed above and set `CLIENT_ORIGIN` to the public frontend URL. The API loads that file regardless of its launch directory, and existing environment variables take precedence over `.env` values. `JWT_SECRET` must match the secret used to sign the user's existing JWT. `GEMINI_API_KEY` enables AI price estimates, fairness analysis, and chore suggestions; manual chore creation and pricing work without it.
4. Run `npm start` to start the API on port `3000`, or use `npm run dev:api` to run it with Node's watch mode during development. If the dashboard reports that an API route was not found, stop the old API process and restart it with `npm run dev:api`; the client proxy expects the API on port `3000`.
5. In a separate terminal, run `npm run dev` for the Vue client. Its Vite proxy forwards `/api` requests to `http://localhost:3000`.

For a single-origin deployment, run `npm run build` followed by `npm start`. The API serves `client/dist`, including history-route fallbacks such as `/ledger` and `/reset-password`, while unknown `/api` endpoints still return JSON 404 responses. Set `CLIENT_ORIGIN` to the public application URL.

In production (`NODE_ENV=production`), PostgreSQL uses SSL with certificate verification enabled. Set `DATABASE_CA_CERT` if your database provider requires a custom CA certificate; escaped `\n` sequences are expanded to newlines.

The API also implements authentication, household-scoped chore creation/listing, completion/deletion, AI chore pricing, fairness analysis, and chore suggestions.

## Tests

Run all tests from the project root with `npm test`, or use `npm run test:unit` for database-free tests and `npm run test:integration` for the PostgreSQL-backed chore, payment, ledger/IOU, shared-expense, and cleaning-supply tests. Test files run serially because integration cases share a database and some temporarily install database-wide triggers. The same scripts are available from `client/`.

The root `.env.test` provides local-only defaults for the PostgreSQL service in `docker-compose.yml`. Start that service with `docker compose up -d postgres` before running the full suite. The test runner creates `roommate_test_db` when needed, initializes an empty database from `database/schema.sql`, and applies the cleaning-supply, IOU, shared-expense, password-reset, and session-version migrations to existing test schemas; it does not drop the database. The configured database account must be able to create databases and the schema extension. If `DATABASE_URL` is explicitly supplied without `TEST_DATABASE_URL`, the runner derives a separate URL using the `roommate_test_db` database name. An explicit `TEST_DATABASE_URL` takes precedence.

For a custom or CI database, set `TEST_DATABASE_URL`, for example `postgres://test_user:test_password@localhost:5432/roommate_test_db`. The runner rejects database names without a `test` marker, refuses a test URL that resolves to the same database endpoint as `DATABASE_URL`, initializes only an empty database, and fails on a partially initialized schema. Use a disposable test database: integration tests create and delete fixture rows and temporarily install a trigger to exercise rollback behavior. The GitHub Actions workflow starts an isolated PostgreSQL service automatically.