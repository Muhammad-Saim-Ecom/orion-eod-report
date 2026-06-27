# Go-Live Setup Guide

Everything needed to (1) finish Slack setup, (2) automate via GitHub, and
(3) run it locally on demand.

---

## 1. Slack: scopes, reinstall, and channel access

### 1a. Required bot scopes

Open <https://api.slack.com/apps> → **Orion EOD Report** → **OAuth & Permissions**
→ **Bot Token Scopes**. You need:

| Scope               | Why                                              | Status        |
| ------------------- | ------------------------------------------------ | ------------- |
| `chat:write`        | Post the report                                  | ✅ already set |
| `chat:write.public` | Post to public channels without being invited    | ✅ already set |
| `im:write`          | DM you when a scheduled run fails                | ⛔ **add this** |

To add `im:write`: **Add an OAuth Scope** → type `im:write` → select it.

### 1b. Reinstall the app

After changing scopes you must reinstall: scroll to the top of **OAuth &
Permissions** → **Reinstall to Workspace** → **Allow**.

> ⚠️ Reinstalling can issue a **new Bot Token** (`xoxb-…`). If it changes, update
> `SLACK_BOT_TOKEN` in your local `.env` **and** in the GitHub secret.

### 1c. Add the bot to the report channel

The production channel is **`C0BD7CKMR7U`**.

- If it's a **public** channel, `chat:write.public` lets the bot post without
  joining — but it's cleaner to invite it anyway.
- If it's **private**, you **must** invite the bot.

In that channel, send: `/invite @Orion EOD Report`

Also make sure the three **FYI** people (and you) are members of the channel so
the `@`-mentions actually notify them.

---

## 2. Automate with GitHub Actions (runs 5 PM ET, Mon–Fri)

### 2a. Create the repo and push

From the project folder:

```bash
git init
git add .
git commit -m "Orion EOD Report"
# create an EMPTY private repo on github.com first, then:
git remote add origin https://github.com/<you>/orion-eod-report.git
git branch -M main
git push -u origin main
```

`.env` is gitignored, so **no secrets are pushed** — you add them in GitHub next.

### 2b. Add Secrets (encrypted)

Repo → **Settings → Secrets and variables → Actions → Secrets → New repository
secret**. Add each:

| Secret                        | Value                                   |
| ----------------------------- | --------------------------------------- |
| `SLACK_BOT_TOKEN`             | your `xoxb-…` token                      |
| `SLACK_CHANNEL_ID`            | `C0BDG9DACKY` (test) — switch to `C0BD7CKMR7U` (production) when ready |
| `NOTION_TOKEN`                | your `ntn_…` token                       |
| `NOTION_MASTER_TRACKER_DB_ID` | `d658b48d-084f-4ed9-90ab-995e0f293846`  |
| `TD_TOKEN`                    | your long-lived Time Doctor token       |
| `TD_COMPANY_ID`               | `Y2Uuqv49XA0GADkC`                       |
| `ALERT_SLACK_USER_ID`         | `U08BF07JRB5`                            |

### 2c. Add Variables (non-secret config)

Same page → **Variables** tab → **New repository variable**:

| Variable                | Value                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `REPORT_ACCOUNTS`       | `Made by Mary,Putt View Books,Mind Body Green,WOLFpak,Shepherds Fashion` |
| `REPORT_FYI_USER_IDS`   | `U1KN22JHH,U05AL5LLD2Q,UHJLGGL5B`                                  |
| `REPORT_TIMEZONE`       | `America/New_York` (optional; this is the default)                |
| `TRACKED_FALLBACK_DAYS` | `90` (optional)                                                    |
| `SKIP_US_HOLIDAYS`      | `false` (optional)                                                 |

### 2d. Done — it now runs automatically

The workflow (`.github/workflows/eod-report.yml`) fires at 5 PM ET on weekdays.
You can watch runs under the repo's **Actions** tab.

### 2e. Run it on demand from GitHub

Repo → **Actions → EOD Report → Run workflow**. Set **force = `true`** to post
immediately regardless of the day/time; leave `false` to respect the schedule
guard.

---

## 3. Run it locally (whenever you want)

With your `.env` filled in:

```bash
npm install          # first time only

npm run connftest    # check all 3 integrations are connected
npm run report:dry   # PREVIEW in the terminal — does NOT post to Slack
npm run report:now   # POST to Slack right now (ignores weekday/5 PM guard)
npm run report       # behaves like the scheduler (only posts Mon–Fri at 5 PM ET)
```

- `report:dry` is the safe way to see output without posting.
- `report:now` is the "post immediately" button.
- To post to the **test** channel instead while experimenting, temporarily set
  `SLACK_CHANNEL_ID=C0BDG9DACKY` in `.env`.

---

## Maintenance notes

- **Time Doctor token expires 2026-12-23.** Before then, generate a new token
  and update `TD_TOKEN` locally and in GitHub.
- Rotate your TD account **password** (it was shared during setup); the app uses
  the token, not the password.
