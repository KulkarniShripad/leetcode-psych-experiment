# Hosting the study for free (Render + Neon)

This puts the app on the internet with a normal `https://` link for participants, and keeps
every answer in a cloud database. Both services have free plans that need no credit card.

| Piece | Service (free plan) | What it does |
|---|---|---|
| The app (web server) | **Render**, free web service | Runs `npm start`, serves the pages and the API at `https://<name>.onrender.com` |
| The data | **Neon**, free Postgres database | Stores every consent, survey answer, question answer and game event |

## Where the data is stored

- **Hosted (this guide):** in your **Neon Postgres database** in the cloud. Each answer is
  written there the moment the participant presses a button, inside a transaction, so a
  refresh, a closed tab or a server restart loses nothing. The Render server keeps no data
  of its own; its disk is wiped every time it restarts, which is why the app **refuses to
  start on Render without `DATABASE_URL`**.
- **On your own computer** (`npm start` with no `DATABASE_URL`): in one SQLite file,
  `confidence-quest/data/app.sqlite`. Handy for trying things out and for the laptop fallback.

Either way the tables are the same: `participants`, `survey_responses`, `question_responses`,
`gamification_events`, `events` (audit log), `allocation_slots` and `meta`. The status page
(`/admin`) shows which one is in use under **Data is stored in**.

How you get the data out:

1. **CSV exports** for analysis: status page → *Exports* (`participants.csv`, `surveys_long.csv`, ...).
   Every column is explained in [`data_dictionary.md`](data_dictionary.md).
2. **Full backup**: status page → *Download full backup*. One JSON file with every table.
   Do this before and after each session and keep the files somewhere safe.
3. **Neon's own console**: *Tables* shows the raw rows; the *SQL Editor* runs queries.

No names, emails, student IDs, IP addresses or device details are ever stored.

---

## Step 1: Create the database on Neon (about 5 minutes)

1. Go to **https://neon.tech** and sign up (the *Continue with GitHub* button is quickest).
2. Create a project:
   - **Project name:** `confidence-quest`
   - **Postgres version:** leave the default.
   - **Region:** the one closest to your participants. In India, choose **AWS Asia Pacific (Singapore)**.
     Remember it: you will pick the same region on Render.
3. On the project dashboard press **Connect**. Copy the **connection string**. It looks like
   ```
   postgresql://neondb_owner:AbC123...@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   Pooled or direct both work. **Treat it like a password**: anyone with it can read the data.
   Do not put it in GitHub, a chat or a slide.

You do not create any tables yourself: the app builds them on its first start.

## Step 2: Get the code on GitHub

The app lives in the `confidence-quest/` folder of
`github.com/KulkarniShripad/leetcode-psych-experiment`. Render deploys from a branch:
either merge the branch `claude/confidence-quest-gamified` into `main`, or point Render at
that branch directly (step 3).

## Step 3: Create the web service on Render (about 10 minutes)

1. Go to **https://render.com**, sign up with GitHub and allow Render to see the
   `leetcode-psych-experiment` repository.
2. **New → Web Service** → pick `leetcode-psych-experiment`.
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Name | `confidence-quest` (this becomes `https://confidence-quest.onrender.com`; if taken, Render adds letters) |
   | Region | **Singapore** (the same region as Neon) |
   | Branch | `main` (or `claude/confidence-quest-gamified`) |
   | Root Directory | `confidence-quest` |
   | Runtime | Node |
   | Build Command | `npm ci` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

4. **Environment Variables** (*Add Environment Variable* for each):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 1 |
   | `ADMIN_TOKEN` | a long random password for the status page. Make one with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` or any 30+ random characters |
   | `ALLOCATION_SEED` | any word you write down, e.g. `cq-study-2026`. It makes the group allocation reproducible |
   | `NODE_ENV` | `production` |

5. Press **Create Web Service**. The first build takes 2-5 minutes. The log should end with
   ```
   Confidence Quest listening on port 10000. Data is stored in: cloud Postgres at ep-....neon.tech
   ```
6. **Settings → Health Check Path:** `/healthz`.

## Step 4: Check it works

1. Open `https://<your-service>.onrender.com/healthz`. You should see `{"ok":true,"storage":"postgres",...}`.
2. Open `https://<your-service>.onrender.com/admin` and enter your `ADMIN_TOKEN`.
   - *Data is stored in:* **Cloud Postgres database (ep-....neon.tech)**.
   - Mode: **LIVE**. Live participants: 0.
3. In Neon, open **Tables**: you should see `participants`, `survey_responses`, and the rest (empty).

## Step 5: Pilot, then clean up

1. Status page → **Switch to PILOT mode**.
2. Have 5-8 classmates do the whole study with the link. Check the **Pilot exports**.
3. Do a full rehearsal on this same setup.
4. Status page → **Delete pilot data** (type `DELETE PILOT DATA`), then **Switch to LIVE mode**.
5. Content changes after this (texts in `server/content/*.json`) mean a new deploy: push to
   GitHub, Render rebuilds automatically, and the change is logged in the data. Code freeze
   48 hours before the study.

## Step 6: On the day

- **Wake the server 10 minutes early.** A free Render service goes to sleep after 15 minutes
  without visitors and takes about a minute to wake up. Open the participant link once, then
  keep the **status page open on the tech laptop**: it refreshes every 5 seconds, which keeps
  the server awake for the whole session.
- **Turn off auto-deploy for the day:** Render → Settings → Build & Deploy → *Auto-Deploy: Off*.
  A deploy during a session restarts the server; no data is lost, but participants would
  see a "connection lost, try again" message for a minute.
- **Backups:** status page → *Download full backup* before and after each session, plus the CSV exports.
- Share the link as a QR code or a short link.

## Free plan limits (and why they are fine)

| Limit | Free plan | This study |
|---|---|---|
| Neon storage | 0.5 GB | ~50 participants × ~100 rows each: well under 5 MB |
| Neon compute | sleeps after 5 min idle, wakes in under a second | Not noticeable |
| Render | 512 MB RAM, sleeps after 15 min idle, 750 hours/month | The app uses ~60 MB; keep the status page open during sessions |
| Render | Disk is wiped on restart | Nothing is stored there; all data is in Neon |

Plans and limits change. If one of them is different when you sign up, the app does not
care: any Postgres connection string works in `DATABASE_URL` (see below).

## Alternatives

- **Supabase** instead of Neon: create a project, then *Connect → Session pooler* and copy
  that URI (the direct one needs IPv6, which Render does not have). If the app logs a
  certificate error, change `sslmode=require` at the end of the URL to `sslmode=no-verify`.
  Note: free Supabase projects pause after a week without use; open the project dashboard
  before the study day.
- **No internet in the room:** run it on one laptop on the room's Wi-Fi (`npm start`, no
  `DATABASE_URL`, data in `data/app.sqlite`). See the README, *Laptop fallback*.

## If something goes wrong

| What you see | What to do |
|---|---|
| Render log: `Refusing to start: this host has no permanent disk. Set DATABASE_URL` | Add `DATABASE_URL` in Render → Environment, then *Manual Deploy* |
| Render log: `password authentication failed` or `getaddrinfo ENOTFOUND` | The connection string is wrong or incomplete. Copy it again from Neon → Connect |
| Render log: `Refusing to start: set ADMIN_TOKEN` | `ADMIN_TOKEN` must be at least 16 characters |
| Render log: `Refusing to start. Content check failed: ...` | A file in `server/content/` has a mistake; the message names the file and field |
| Status page asks for the token again | Wrong token; it is the `ADMIN_TOKEN` value from Render |
| The first page takes a minute | The free server was asleep; it stays awake while people use it |
