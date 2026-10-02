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

## Commands

- Send a bare number (`50`, `+50`) or a natural sentence ("did 50 today,
  alhamdulillah", "صليت ٥٠ صلوات") to log that many salawat. Works in English
  and Arabic.
- `/stats` — all-time salawat totals, broken down by day of week (ASCII bar
  chart). Also triggered by natural phrasing like "show me the stats".
- `/me` — privately sends you your own submission history.
- `/awlia` — lists everyone who has submitted at least once, in random order
  (not ranked by count).
- `/help` — lists the commands above and briefly explains how the counting
  works, in English and Arabic.
- `/unsubscribe` — opts out of the weekly private digest DM (see below). On by
  default for everyone.
- `/subscribe` — opts back in.

Whenever one or more new members join the group, the bot automatically sends
each of them a personal welcome message (using their name if it already knows
it from a prior submission, otherwise a generic greeting, plus the current
total and goal), followed by a single `/help` message for the whole batch of
joiners.

When a submission brings the group total to (or past) the goal, the bot
follows its usual reply with a one-off congratulations message to the whole
group (in all five languages, with the final total and how many people took
part). It fires exactly once per goal: the celebrated goal is recorded in the
`Setting` row, so later submissions don't repeat it, and raising the goal with
`/update-goal` re-arms it for the new target.

## Weekly digest

Once a week, every subscribed user who logged at least one salawat in the
last rolling 7 days gets a private DM with their own count and a day-by-day
breakdown for that window (same bar-chart style as `/stats`, but scoped to
them). The message also explains `/unsubscribe`/`/subscribe` inline, since
that's the only place most users will ever see it.

This isn't driven by the normal message pipeline — see
[InternalListener](#internallistener) and
[Deploy the weekly-digest cron job](#3-deploy-the-weekly-digest-cron-job)
below for how it's triggered and deployed.

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
- `/stats`, `/me`, `/awlia`, `/help`

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

## 3. Deploy the weekly-digest cron job

The weekly digest (see [above](#weekly-digest)) needs two pieces on Railway,
both in the **same project** as the bot:

1. **An internal-only endpoint on the bot service itself.** The bot process
   already starts one (see [InternalListener](#internallistener)) as long as
   `INTERNAL_API_SECRET` is set:
   ```bash
   railway variables --set "INTERNAL_API_SECRET=<a long random secret>" \
                      --set "INTERNAL_PORT=8080"
   ```
   Do **not** run `railway domain` / generate a public domain for this
   service's port — the endpoint must only be reachable over Railway's
   private network (`<service>.railway.internal`), never the public
   internet. The shared secret is a second layer of defense on top of that,
   not a substitute for it.

2. **A second, separate service that calls it on a schedule** —
   `weekly-digest-cron`, deployed from this same repo/branch
   (`scripts/weekly-digest-cron.ts`), configured with:
   - Start command: `npx tsx scripts/weekly-digest-cron.ts`
   - Cron Schedule (Settings → Deploy): `0 7 * * 5` (Fridays 07:00 UTC —
     adjust for your timezone; Railway cron has no timezone setting, so this
     drifts an hour across DST changes)
   - Restart Policy: `Never` (it's a run-once-and-exit script, not a
     persistent service)
   - Variables:
     ```bash
     railway variables --set "TARGET_URL=http://<bot-service>.railway.internal:8080/weekly-digest" \
                        --set "INTERNAL_API_SECRET=<same secret as step 1>"
     ```

Railway only *executes* a cron-scheduled service's start command at the
scheduled time — pushing new code just rebuilds the image and leaves it on
standby, it does not run the script early.

## Testing

Unit tests use [Vitest](https://vitest.dev) and mock the Anthropic SDK,
Prisma client, and Baileys socket, so they run fully offline — no API keys,
database, or WhatsApp connection needed.

```bash
npm test          # run once
npm run test:watch # watch mode
```

Every push and pull request to `main` and `staging` runs typecheck + tests
via GitHub Actions (`.github/workflows/ci.yml`).

## Notes

- The bot only needs to be added to the group once — no ongoing manual work.
- Submissions and users are stored in Postgres (see
  [Database Setup](#database-setup--salawat-bot) below); back it up
  periodically if the campaign matters a lot to you.
- The WhatsApp login session lives under `DATA_DIR` (default `data/`, or
  `/data` on Railway) — that's what needs a persistent Volume, not the count.
- If WhatsApp logs the session out (rare, but possible), you'll need to
  rescan a fresh QR code from the logs.

## Admin-only commands

Deliberately undocumented in `/help` and unknown to the natural-language
classifier — these only work as an exact, literal command, so anyone who
doesn't already know the syntax has no way to discover them from the bot
itself. There's no sender restriction on these today (anyone in the group
who knows the syntax can use them).

- `/update-goal <number>` — changes the group's shared salawat goal (persisted
  in Postgres, overriding `SALAWAT_GOAL` from then on). Example:
  `/update-goal 200000`.

# salawat-bot — Architecture

## Diagram

```mermaid
flowchart TB
    WA["WhatsApp"] -->|incoming message / group join| MSG["Messenger"]
    MSG -->|reply / DM| WA

    MSG -->|raw message| INT["Interpreter"]
    REN -->|formatted result| MSG

    INT -->|classify intent| CLAUDE["Claude API"]
    INT -->|command| DISP["Dispatcher"]

    CRON["weekly-digest-cron<br/>(Railway service, Fri 07:00 UTC)"] -->|"POST /weekly-digest<br/>+ shared secret"| IL["InternalListener"]
    IL -->|trigger| DISP

    DISP -->|query/update| DBJS["DB.js"]
    DBJS -->|data| DISP
    DBJS <--> DB[("DB")]

    DISP -->|raw result| REN["Presenter"]
    REN -->|format/caption| CLAUDE
```

`Messenger` and `InternalListener` are peers: both sit on an I/O boundary
(a WhatsApp socket, an HTTP port) waiting for external events and handing
them to registered handlers, same `connect()`/`addXHandler()` shape. Neither
knows about the other — they both just feed the `Dispatcher` and get their
replies sent back out through `Messenger`.

---

## Modules

### WhatsApp

The external channel. End users send and receive messages here. No logic lives in this layer — it's purely the transport the Messenger integrates with.

### Messenger

Owns the WhatsApp integration (Baileys).

- Listens for incoming WhatsApp messages, plus `group-participants.update`
  events (used to auto-greet new members with a welcome + `/help` message)
- Sends outgoing WhatsApp messages (replies, notifications)
- Passes raw incoming text to the **Interpreter**
- Receives the formatted result directly from the **Presenter** and sends it back to the user over WhatsApp
  Entry point on the way in (to the Interpreter) and exit point on the way out (from the Presenter).

### InternalListener

Owns the internal-only HTTP endpoint (`POST /weekly-digest`) that triggers
the weekly digest fan-out. Runs inside the same process as the bot, on a
port that must never be exposed publicly — only reachable via Railway's
private network, gated further by a shared secret header
(`x-internal-secret`, constant-time compared).

- `listen(port, secret)` — starts the HTTP server (async, resolves once bound)
- `addWeeklyDigestHandler(handler)` — registers the handler invoked on a
  valid request, mirroring `Messenger.addMessageHandler` /
  `addGroupJoinHandler` (a dedicated method per trigger kind, not a generic
  router)
- `close()` — stops listening

It does not call the Dispatcher directly — `src/index.ts` wires
`addWeeklyDigestHandler` to a small orchestration function (same pattern as
the message and group-join handlers) that calls
`Dispatcher.buildWeeklyDigests()`, formats each result via the
**Presenter**, and sends it via the **Messenger**. See
[Weekly digest cron job](#3-deploy-the-weekly-digest-cron-job) for what
calls this endpoint and when.

### Interpreter

Owns the NLU layer.

- Takes a raw, freeform user message from the **Messenger**
- Fast-paths obvious cases locally (literal `/stats`, `/me`, `/help`,
  `/awlia`, a bare number) to avoid an API call
- Otherwise uses Claude to classify intent (`salawat` / `stats` / `me` /
  `help` / `awlia` / `none`) and extract a structured command
- Passes that structured command to the **Dispatcher**
  A one-way step in the pipeline — it hands off to the Dispatcher and isn't involved in returning the result.

### Dispatcher

Owns command execution — the business logic core of the bot.

- Receives a structured command from the **Interpreter**, or a weekly-digest
  trigger from the **InternalListener** (`buildWeeklyDigests()` /
  `markWeeklyDigestSent()` - not Command-driven, same as `handleGroupJoin()`)
- Executes the appropriate logic for that command
- Reads/writes persistent data via **DB.js** (no external API calls happen here)
- Passes the raw result to the **Presenter**
  This is where you'd add new commands/features as the bot grows — it's the natural extension point.

### Presenter

Owns presentation — turning raw data from the Dispatcher into a human-friendly, nicely formatted message (ASCII bar charts, multilingual text, emojis).

- Receives the raw result from the **Dispatcher**
- For `salawat`/`stats` responses, asks Claude to write a short caption
  around fixed, non-negotiable data (the bar chart lines, the total), and
  falls back to a hardcoded template if Claude's output is malformed
- `/help` and `/awlia` are fully hardcoded (English + Arabic only) rather
  than AI-generated, since a command listing or a name roster needs to stay
  exactly accurate (and, for `/awlia`, keep its random order un-touched)
- Sends the formatted result directly to the **Messenger**
  Keeps formatting concerns out of the Dispatcher entirely — business logic doesn't need to know or care how its output will look on WhatsApp.

### DB.js

Owns all database access.

- Wraps Postgres/Prisma queries used by the Dispatcher
- Single choke point for reads/writes, so query logic isn't scattered across the app

### DB

PostgreSQL — local via Docker in development, Railway-hosted in production. Schema and setup details are in the [Database Setup](#database-setup--salawat-bot) section below.

---

## Message flow (happy path)

1. User sends a message (or joins the group) on **WhatsApp**
2. **Messenger** receives it, forwards the raw text to the **Interpreter**
   (a join event bypasses the Interpreter entirely and goes straight to the
   Dispatcher for a welcome message, then a synthetic `/help` command)
3. **Interpreter** interprets it into a structured command, sends it to the **Dispatcher**
4. **Dispatcher** executes the command — reading/writing via **DB.js** as needed
5. **Dispatcher** passes the raw result to the **Presenter**
6. **Presenter** formats it into a human-friendly message and sends it to **Messenger**
7. **Messenger** sends the reply back over **WhatsApp**

## Weekly digest flow (cron-triggered)

1. The `weekly-digest-cron` Railway service fires on its schedule (Fridays
   07:00 UTC), runs `scripts/weekly-digest-cron.ts`, and exits
2. That script `POST`s `/weekly-digest` to the bot's **InternalListener**
   over Railway's private network, with the shared secret header
3. **InternalListener** authenticates the request, invokes the registered
   handler (wired in `src/index.ts`), and immediately responds `202
   { "accepted": true }` — it does **not** wait for the fan-out to finish.
   The whole run takes many minutes (one DM at a time, `DIGEST_SEND_DELAY_MS`
   apart - deliberately slow, see below), which would otherwise exceed the
   cron script's own HTTP client timeout
4. In the background, that handler calls **Dispatcher.buildWeeklyDigests()**
   — one result per eligible subscribed user (salawat in the last rolling 7
   days, not already digested this window, **and a known `chatId`** - users
   who haven't sent a message since that field was introduced are skipped
   until they do, rather than guessing a JID from `phoneNumber`)
5. For each result: **Presenter** formats the personal digest message,
   **Messenger** DMs it to that user, then **Dispatcher.markWeeklyDigestSent()**
   records it, waiting `DIGEST_SEND_DELAY_MS` (default 1 minute) between each
   — much slower than the group-join welcome batch's `SEND_DELAY_MS`, since a
   burst of individual DMs to many different people reads as spammy/bot-like
   to WhatsApp's abuse detection and can get the account logged out
6. The handler logs its final count (`Weekly digest: sent to <n> user(s).`)
   in the bot service's own logs once done - the cron script never sees this
   number, only the earlier `202` acknowledgement

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
  id                Int          @id @default(autoincrement())
  phoneNumber       String       @unique
  name              String?
  createdAt         DateTime     @default(now())
  submissions       Submission[]
  /// Opted in to the weekly salawat digest DM. Defaults to true; toggled via /subscribe and /unsubscribe.
  subscribed        Boolean      @default(true)
  /// When the weekly digest was last sent to this user - guards against re-sending within the same rolling week.
  lastDigestSentAt  DateTime?
  /// The exact WhatsApp JID (sender.id) to DM this user at - captured from their messages, same identifier /me
  /// already replies to successfully. phoneNumber alone isn't reliably reconstructible into a valid JID (e.g.
  /// group senders using WhatsApp's privacy-preserving @lid identifiers instead of a real phone-number JID).
  /// Null until their first message is seen after this field was introduced.
  chatId            String?
}

model Submission {
  id          Int      @id @default(autoincrement())
  count       Int      @default(0)
  submittedAt DateTime @default(now())
  author      User     @relation(fields: [authorId], references: [id])
  authorId    Int
}

// Singleton row (id always 1) holding group-wide, runtime-configurable settings.
model Setting {
  id   Int @id @default(1)
  goal Int @default(100000)
}
```

---

## Production — Railway

### Project layout

Project: **whatsApp auto replay claude bot**
Environment: `production` and `staging` (as of the weekly-digest work, the
bot is deliberately kept running in `staging` only — `production` is off)

Services (same project, so Railway's `${{ServiceName.VAR}}` reference syntax works):

- `whatsAppAiClaudeBot` — the Node app (WhatsApp connection + InternalListener)
- `Postgres` — dedicated Postgres instance
  > Note: a Postgres instance was briefly created in a separate Railway project (`empowering-gratitude`) by mistake, then deleted. Cross-project references don't work with the `${{ }}` shorthand — that's why both services need to live in the same project.
- `weekly-digest-cron` — the cron-scheduled service described in
  [Deploy the weekly-digest cron job](#3-deploy-the-weekly-digest-cron-job)
  above. Its `TARGET_URL` points at `whatsAppAiClaudeBot`'s private network
  address; its `INTERNAL_API_SECRET` must match the same variable there.

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
