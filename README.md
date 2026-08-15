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
