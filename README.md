# Roommate Chore List — Pay Per Chore, IOUs & Venmo

A proposal for a full-stack application for roommates to manage household chores, track pay-per-chore payments, and settle IOUs — powered by AI suggestions.

> **This repository contains a design proposal only, not a runnable application.** It currently has no application source code, Compose configuration, database migrations, or seed data. The architecture, features, setup steps, credentials, and API endpoints below describe the proposed implementation.

## Architecture

```
Vue 3 Client (Vite, Pinia, Tailwind)
   |  (JWT Bearer Token / JSON REST)
[ Express API Server (Node.js) ]
   |           |           |
[ Auth ]   [ AI ]   [ PostgreSQL ]
(bcrypt)  (Gemini)  - Atomic Ledger Transactions
                  - Chore CRUD & Relational Schemas
```

## Features

- **User Authentication** — Register, login, JWT-based sessions with bcrypt password hashing
- **Chore CRUD** — Create, read, update, complete, and delete chores
- **Pay-Per-Chore Ledger** — Atomic transactions track who owes whom; all monetary values stored as integer cents
- **IOU Tracking** — Real-time summary of who owes whom, mark payments as settled
- **AI-Powered Suggestions** — Gemini AI suggests new chores and analyzes fairness of chore distribution
- **Payment Reminders** — Schedule and track payment reminders

## Proposed Setup (Not Runnable)

The following steps are for the planned application and cannot be run with the contents of this repository.

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- (Optional) Google Gemini API key for AI features

### 1. Start PostgreSQL

```bash
docker compose up -d
```

### 2. Backend Setup

```bash
cd server
npm install
npx knex migrate:latest
npx knex seed:run
npm run dev
```

Server runs at `http://localhost:3000`

### 3. Frontend Setup

```bash
cd client
npm install
npm run dev
```

App runs at `http://localhost:5173`

### 4. Configure AI (Optional)

Add your Gemini API key to `server/.env`:

```
GEMINI_API_KEY=your-api-key-here
```

## Planned Demo Credentials

The planned seed data would create two users; these credentials are not available in a running application:

| Email | Password |
|-------|----------|
| alice@example.com | password123 |
| bob@example.com | password123 |

## Proposed API Endpoints

### Auth
- `POST /api/auth/register` — Register new user
- `POST /api/auth/login` — Login and receive JWT
- `GET /api/auth/me` — Get current user profile

### Chores
- `GET /api/chores` — List all chores
- `POST /api/chores` — Create a chore
- `PUT /api/chores/:id` — Update a chore
- `PATCH /api/chores/:id/complete` — Mark chore as complete (creates ledger entry)
- `DELETE /api/chores/:id` — Delete a chore

### Ledger
- `GET /api/ledger` — Get all transactions for current user
- `GET /api/ledger/summary` — Get IOU summary (owed/owing breakdown)
- `POST /api/ledger/iou` — Create manual IOU entry
- `PATCH /api/ledger/:id/paid` — Mark transaction as paid

### AI
- `POST /api/ai/suggest-chores` — Get AI chore suggestions
- `POST /api/ai/fair-split` — Get fairness analysis

### Reminders
- `GET /api/reminders` — Get payment reminders
- `POST /api/reminders` — Create a reminder
- `POST /api/reminders/send-due` — Process due reminders

## Data Integrity

- All monetary values are stored as **integer cents** (not floats) to prevent rounding errors
- Database constraints ensure `from_user != to_user` in ledger transactions
- Atomic transactions for chore completion + ledger entry creation
- Foreign key constraints with proper cascade behavior

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vue 3, Vite, Pinia, Tailwind CSS, Vue Router |
| Backend | Express.js, Node.js |
| Database | PostgreSQL 16, Knex.js |
| Auth | JWT, bcrypt |
| AI | Google Gemini API |
| Security | Helmet, CORS, Rate Limiting |
