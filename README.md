# Orion EOD Report

Automated **End-of-Day** report posted to Slack every day at **5:00 PM ET**, combining data from **Time Doctor**, **Notion**, and **Slack**.

For each account/client, the report lists the cards worked on today with status, estimated hours, hours tracked, and hours pushed to QI/Done.

## Architecture

```
src/
├── config/       env loading + zod validation (fail fast on missing secrets)
├── utils/        logger, timezone/day-window helpers, fetch+retry
├── domain/       API-agnostic core types (ReportCard, AccountGroup, EodReport)
├── integrations/ dumb data-fetchers — one per external system
│   ├── slack/        post-only WebClient wrapper
│   ├── notion/       Master Tracker reader
│   └── timedoctor/   login + projects/tasks/worklog
├── services/     (Phase 4+) matching + aggregation business logic
├── scheduler/    runDailyReport() — single deploy-agnostic entrypoint
└── index.ts      CLI
```

**Design principle:** integrations only fetch raw data; the `domain/` layer holds
neutral types so external API shapes never leak into reporting logic.

### Data model

A card appears in the report only if its **Time Doctor task** had tracked time today.

| Report field            | Source                                                        |
| ----------------------- | ------------------------------------------------------------- |
| Account (group)         | Notion `Client` relation (= Time Doctor Project)              |
| Card title + link       | Notion `Name` + page URL                                      |
| Status                  | Notion `Status`                                               |
| Hours Estimated         | Notion `Projected Dev Hours` + `Buffer Hours`                 |
| Hours Tracked           | Time Doctor worklog for the card's task                       |
| Hours Pushed to QI/Done | Notion `Executed Task Hours`                                  |

The Notion↔Time Doctor join is an ID lookup: each Master Tracker card stores a
`Time Doctor Project ID` (the TD **task**) and `Time Doctor (Client) Project ID`
(the TD **project** = account).

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values
```

See `.env.example` for every required variable.

## Usage

```bash
npm run connftest    # verify Slack + Notion + Time Doctor connectivity
npm run report:dry   # run the report, printing to console (no Slack post)
npm run report       # run the report and post to Slack
npm run typecheck    # strict TypeScript check
```

## Status

- **Phase 1–6 ✅** — scaffold, integrations, matching, Slack report, scheduler.
- Phase 7 — additional metrics / improvements.

## Scheduling & deployment

Runs as a scheduled batch job (no always-on server) via **GitHub Actions**
(`.github/workflows/eod-report.yml`):

- Posts at **5:00 PM America/New_York, Monday–Friday**.
- GitHub cron is UTC with no DST awareness, so the workflow fires at both
  21:00 UTC (EDT) and 22:00 UTC (EST); the app's `localHour === 17` guard makes
  only the correct one post. Weekends are skipped in code and in cron.
- US holidays are **not** skipped by default (`SKIP_US_HOLIDAYS=false`); flip the
  var to `true` to enable.
- On failure, the app DMs `ALERT_SLACK_USER_ID` and exits non-zero (red CI run).
- Manual run: the **workflow_dispatch** trigger (Actions tab) with `force=true`
  runs regardless of day/time. Locally: `npm run report -- --force`.

### Required GitHub configuration

Add these in the repo (Settings → Secrets and variables → Actions):

**Secrets:** `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `NOTION_TOKEN`,
`NOTION_MASTER_TRACKER_DB_ID`, `TD_TOKEN`, `TD_COMPANY_ID`,
`ALERT_SLACK_USER_ID`.

> **Time Doctor auth:** prefer the long-lived `TD_TOKEN` so your account
> password is never stored. `TD_EMAIL` + `TD_PASSWORD` are supported only as a
> fallback (the app logs in to mint a token) — avoid them. When the token
> expires, generate a new one and update the `TD_TOKEN` secret.

**Variables:** `REPORT_ACCOUNTS`, `REPORT_FYI_USER_IDS`, `REPORT_TIMEZONE`
(optional), `TRACKED_FALLBACK_DAYS` (optional), `SKIP_US_HOLIDAYS` (optional).

The Slack app needs the `im:write` scope for failure DMs (in addition to
`chat:write`, `chat:write.public`).
