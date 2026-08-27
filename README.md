# Salawat Counter Bot

A WhatsApp bot for a group salawat-counting campaign. It joins your group as a
normal member (via WhatsApp Web login), reads submission messages, uses Claude
to parse the count and write a warm update message, and replies with the
running total.

⚠️ This uses an **unofficial** WhatsApp client (Baileys), which logs in as a
real account via QR code — not Meta's official Business API (which can't post
inside group chats). Use a spare/secondary number for the bot, not your main
personal number, and avoid replying to every single message in a very busy
group, to keep the account looking like normal usage.

## 1. Run it locally first (to test + log in)

```bash
npm install
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
npm start
```

A QR code will print in your terminal. Scan it with the WhatsApp account you
want to use as the bot (Linked Devices → Link a Device). Once connected, add
that number to your salawat WhatsApp group.

Send a test message in the group — the console will log the group's chat ID
(looks like `123456789-123456789@g.us`). Copy it into `GROUP_ID` in `.env`,
restart, and from then on the bot only reacts inside that group.

Try sending things like:

- `+50`
- `50 salawat`
- `did 100 today, alhamdulillah`

## 2. Deploy to Railway

Railway keeps this running 24/7 as a persistent process — good fit, since the
bot needs a constant WhatsApp connection.

**Important:** attach a Volume, or your login session and salawat count reset
every time you redeploy.

### Steps

1. Install the Railway CLI and log in:
   ```bash
   npm install -g @railway/cli
   railway login
   ```
2. From inside this project folder:
   ```bash
   railway init
   ```
3. In the Railway dashboard, open the new service → **Settings → Volumes** →
   attach a volume and mount it at `/data`.
4. Set environment variables (dashboard, or via CLI):
   ```bash
   railway variables --set "ANTHROPIC_API_KEY=sk-ant-..." \
                      --set "DATA_DIR=/data" \
                      --set "SALAWAT_GOAL=100000"
   ```
   Leave `GROUP_ID` unset for now.
5. Deploy:
   ```bash
   railway up
   ```
6. Open the deployment logs in the Railway dashboard — the QR code will print
   there. Scan it with the bot's WhatsApp account.
7. Add the bot number to your group, send a test message, and copy the logged
   group ID into the `GROUP_ID` variable (`railway variables --set "GROUP_ID=...@g.us"`).
   This redeploys automatically.

From then on, every valid salawat submission in the group gets tallied and
answered with an AI-generated update automatically.

## Notes

- The bot only needs to be added to the group once — no ongoing manual work.
- `data/count.json` (or `/data/count.json` on Railway) holds the running
  total; back it up periodically if the campaign matters a lot to you.
- If WhatsApp logs the session out (rare, but possible), you'll need to
  rescan a fresh QR code from the logs.

# salawat-bot — Architecture

## Diagram

```mermaid
flowchart TB
    WA["WhatsApp"] -->|incoming message| MSG["Messenger"]
    MSG -->|reply| WA

    MSG -->|raw message| INT["Interpreter"]
    REN -->|formatted result| MSG

    INT -->|command| ORC["Orchestrator"]

    ORC -->|query/update| DBJS["DB.js"]
    DBJS -->|data| ORC
    DBJS <--> DB[("DB")]

    ORC -->|request| API["Web API"]
    API -->|response| ORC

    ORC -->|raw result| REN["Presenter"]
```

---

## Modules

### WhatsApp

The external channel. End users send and receive messages here. No logic lives in this layer — it's purely the transport the Messenger integrates with.

### Messenger

Owns the WhatsApp integration.

- Listens for incoming WhatsApp messages
- Sends outgoing WhatsApp messages (replies, notifications)
- Passes raw incoming text to the **Interpreter**
- Receives the formatted result directly from the **Presenter** and sends it back to the user over WhatsApp
  Entry point on the way in (to the Interpreter) and exit point on the way out (from the Presenter).

### Interpreter _(formerly "Claude.js")_

Owns the NLU layer.

- Takes a raw, freeform user message from the **Messenger**
- Uses Claude to interpret intent and extract a structured command
- Passes that structured command to the **Orchestrator**
  A one-way step in the pipeline — it hands off to the Orchestrator and isn't involved in returning the result.

### Orchestrator _(formerly "Commander")_

Owns command execution — the business logic core of the bot.

- Receives a structured command from the **Interpreter**
- Executes the appropriate logic for that command
- Reads/writes persistent data via **DB.js**
- Calls out to the **Web API** when external data or actions are needed
- Passes the raw result to the **Presenter**
  This is where you'd add new commands/features as the bot grows — it's the natural extension point.

### Presenter

Owns presentation — turning raw data from the Orchestrator into a human-friendly, nicely formatted message (ASCII art, tables, emojis, whatever fits the channel).

- Receives the raw result from the **Orchestrator**
- Formats/beautifies it into a display-ready message
- Sends the formatted result directly to the **Messenger**
  Keeps formatting concerns out of the Orchestrator entirely — business logic doesn't need to know or care how its output will look on WhatsApp.

### DB.js

Owns all database access.

- Wraps Postgres/Prisma queries used by the Orchestrator
- Single choke point for reads/writes, so query logic isn't scattered across the app

### DB

PostgreSQL — local via Docker in development, Railway-hosted in production. Schema and setup details live in `db-setup.md`.

### Web API

Any external HTTP API the Orchestrator needs to call to fulfill a command (e.g. fetching prayer times, external data lookups, etc. — fill in as concretely defined).

---

## Message flow (happy path)

1. User sends a message on **WhatsApp**
2. **Messenger** receives it, forwards the raw text to the **Interpreter**
3. **Interpreter** interprets it into a structured command, sends it to the **Orchestrator**
4. **Orchestrator** executes the command — reading/writing via **DB.js** and/or calling the **Web API** as needed
5. **Orchestrator** passes the raw result to the **Presenter**
6. **Presenter** formats it into a human-friendly message and sends it to **Messenger**
7. **Messenger** sends the reply back over **WhatsApp**

# Database Setup — salawat-bot

## Stack

- **PostgreSQL** — local via Docker, production via Railway
- **Prisma 7** (`prisma@7.10.0`, `@prisma/client@7.10.0`) — ORM + migrations
- **Node 24** (`engines.node >= 24.0.0` in `package.json`)

---

## Local development

### 1. Postgres runs in Docker

`docker-compose.yml` (project root):

```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: myapp_dev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

`.env` (gitignored):

```dotenv
DB_PASSWORD=mysecretpassword
DATABASE_URL="postgresql://postgres:mysecretpassword@localhost:5432/myapp_dev"
```

### 2. npm scripts

```json
{
  "scripts": {
    "db:up": "docker compose up -d",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d",
    "db:logs": "docker compose logs -f postgres",
    "db:studio": "prisma studio",
    "db:migrate": "prisma migrate dev"
  }
}
```

Daily workflow:

```bash
npm run db:up        # start Postgres in Docker
npm run db:migrate    # apply schema changes
npm run db:studio     # browse data visually
npm run db:down       # stop Postgres
```

---

## Prisma 7 — key differences from older versions

Prisma 7 changed several things that broke the "usual" setup. Notes for future reference:

- **CLI init command renamed**: some contexts use `prisma orm init` instead of `prisma init` (depends on exact version/RC).
- **`datasource.url` no longer goes in `schema.prisma`.** Connection URL now lives in `prisma.config.ts`:

  ```typescript
  // prisma.config.ts
  import "dotenv/config";
  import { defineConfig, env } from "prisma/config";

  export default defineConfig({
    schema: "prisma/schema.prisma",
    migrations: {
      path: "prisma/migrations",
    },
    datasource: {
      url: env("DATABASE_URL"),
    },
  });
  ```

  `schema.prisma` datasource block now just declares the provider:

  ```prisma
  datasource db {
    provider = "postgresql"
  }
  ```

- **Prisma 7 does not auto-load `.env`** — the `import "dotenv/config"` line at the top of `prisma.config.ts` is required, or `DATABASE_URL` will be undefined during migrations.
- **`PrismaClient` requires an explicit adapter** — no more zero-config `new PrismaClient()`.

  ```bash
  npm install @prisma/adapter-pg
  ```

  ```js
  import { PrismaClient } from "@prisma/client";
  import { PrismaPg } from "@prisma/adapter-pg";
  import "dotenv/config";

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  export default prisma;
  ```

- **`postinstall` should just be**:
  ```json
  "postinstall": "prisma generate"
  ```
  (Prisma 7/8-rc briefly introduced a `prisma skills sync` postinstall step that syncs unrelated `.claude` / `.agents` skill docs — not needed for DB work, safe to ignore or remove.)

---

## Current schema (`prisma/schema.prisma`)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model User {
  id          Int          @id @default(autoincrement())
  phoneNumber String       @unique
  name        String?
  createdAt   DateTime     @default(now())
  submissions Submission[]
}

model Submission {
  id          Int      @id @default(autoincrement())
  count       Int      @default(0)
  submittedAt DateTime @default(now())
  author      User     @relation(fields: [authorId], references: [id])
  authorId    Int
}
```

---

## Production — Railway

### Project layout

Project: **whatsApp auto replay claude bot**
Environment: `production`

Services (same project, so Railway's `${{ServiceName.VAR}}` reference syntax works):

- `whatsAppAiClaudeBot` — the Node app
- `Postgres` — dedicated Postgres instance
  > Note: a Postgres instance was briefly created in a separate Railway project (`empowering-gratitude`) by mistake, then deleted. Cross-project references don't work with the `${{ }}` shorthand — that's why both services need to live in the same project.

### Environment variable

On the `whatsAppAiClaudeBot` service, `DATABASE_URL` is set to:

```
${{Postgres.DATABASE_URL}}
```

This pulls the connection string live from the `Postgres` service — no manual copy-pasting, stays in sync if credentials rotate.

### Outstanding step: run migrations in production

Local `prisma migrate dev` only affects the local Docker DB — it does **not** touch Railway's Postgres. Production tables are currently **empty** and need migrations applied there separately.

**Plan:** add `prisma migrate deploy` to the Railway start command so it runs automatically on every deploy:

Railway dashboard → `whatsAppAiClaudeBot` service → **Settings → Deploy → Start Command**:

```bash
npx prisma migrate deploy && node index.js
```

Why this is safe to run on every deploy: `migrate deploy` checks the `_prisma_migrations` tracking table and only applies migrations that haven't run yet. If nothing's new, it's a fast no-op — this is the standard/recommended pattern for running Prisma in production.

### Viewing production data

Options:

- Railway dashboard → `Postgres` service → **Data** tab (built-in browser, no setup)
- Prisma Studio pointed at prod: `DATABASE_URL="<railway-connection-string>" npx prisma studio` (⚠️ operates directly on live data — be careful with edits/deletes)
- Railway CLI: `railway connect Postgres` (drops into `psql`)
- Any Postgres GUI (TablePlus, DBeaver, Postico) using the public connection string from the `Postgres` service's Variables tab

---

## Open TODOs

- [x] Set Railway start command to `npx prisma migrate deploy && node index.js`
- [x] Confirm tables appear in Railway's Postgres after next deploy
- [x] Rename any stray `prisma7.config.ts` → `prisma.config.ts` if still present
