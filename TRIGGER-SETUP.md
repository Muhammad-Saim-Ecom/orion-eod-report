# Reliable Trigger Setup (cron-job.org → GitHub)

GitHub's built-in scheduler (`cron:` in the workflow) is best-effort and was
**skipping our scheduled runs**. This replaces only the timing trigger with a
reliable external scheduler. GitHub still runs the actual report.

## Why
GitHub cron only understands UTC and unreliably fires (especially new repos).
cron-job.org lets you pick the time directly in **America/New_York**, so there's
no UTC / daylight-savings juggling, and it fires dependably.

## One-time setup

### 1. GitHub token (the key that triggers the run)
- https://github.com/settings/personal-access-tokens/new (fine-grained)
- Name: `eod-cron-trigger`; Expiration: 1 year
- Repository access: Only select repositories → **orion-eod-report**
- Permissions → Repository permissions → **Actions: Read and write**
- Generate → copy the `github_pat_...` token.

### 2. cron-job.org job
Sign up (free) at https://cron-job.org, create a cronjob:

- **URL:**
  `https://api.github.com/repos/Muhammad-Saim-Ecom/orion-eod-report/actions/workflows/eod-report.yml/dispatches`
- **Schedule:** every **Mon–Fri at 17:00**, timezone **America/New_York**
  (for testing, set whatever time you want — it's just a dashboard field)
- **Request method:** POST
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer github_pat_...`  ← your token
  - `X-GitHub-Api-Version: 2022-11-28`
- **Request body:** `{"ref":"main"}`

### 3. GitHub Variable
Set `REPORT_POST_HOUR` = `17` (5 PM). Because cron-job.org fires at the real
local time, the workflow's own `cron:` line is no longer the trigger — it can be
left as-is or removed. The app still guards on REPORT_POST_HOUR as a safety net.

## Testing the time
To test, just change the **time field in the cron-job.org dashboard** (and set
`REPORT_POST_HOUR` to match that hour). No code edits, no pushing. Watch the
test channel. Once confident, set it to 17:00 and switch SLACK_CHANNEL_ID to the
production channel.
