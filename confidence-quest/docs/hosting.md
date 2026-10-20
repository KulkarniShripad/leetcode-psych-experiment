# Hosting the study for free (Vercel + Neon)

This puts the app on the internet with a normal `https://` link for participants, and keeps
every answer in a cloud database. Both services have free plans.

| Piece | Service (free plan) | What it does |
|---|---|---|
| The app (web server) | **Vercel**, runs the app's `Dockerfile` as a container | Serves the pages and the API at `https://<name>.vercel.app` |
| The data | **Neon**, free Postgres database | Stores every consent, survey answer, question answer and game event |

Render works too instead of Vercel; see [Alternative: Render](#alternative-render) at the end.

## Where the data is stored

- **Hosted (this guide):** in your **Neon Postgres database** in the cloud. Each answer is
  written there the moment the participant presses a button, inside a transaction, so a
  refresh, a closed tab or a server restart loses nothing. Vercel keeps no data of its own:
  it starts and stops copies of the app as visitors come and go, and their disks are thrown
  away. That is why the app **refuses to start on Vercel (or Render) without a database
  connection string**.
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
     Remember it: Vercel must run in the same region (step 3.6).
3. On the project dashboard press **Connect**. Copy the **connection string**. It looks like
   ```
   postgresql://neondb_owner:AbC123...@ep-cool-name-123456-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
   ```
   Use the **pooled** one (its host has `-pooler` in it); Vercel may run several copies of the
   app at once and the pooler handles that. **Treat it like a password**: anyone with it can
   read the data. Do not put it in GitHub, a chat or a slide.

You do not create any tables yourself: the app builds them on its first start.

## Step 2: Get the latest code onto `main`

Vercel deploys the `main` branch of `github.com/KulkarniShripad/leetcode-psych-experiment`.
The app lives in its `confidence-quest/` folder. When there are new changes on the branch
`claude/confidence-quest-gamified`, open a pull request from that branch into `main` on
GitHub and merge it; Vercel then builds automatically.

## Step 3: Create the project on Vercel (about 10 minutes)

1. Go to **https://vercel.com**, sign up with GitHub and allow Vercel to see the
   `leetcode-psych-experiment` repository.
2. **Add New → Project** → **Import** `leetcode-psych-experiment`.
3. **Root Directory:** press *Edit* and choose **`confidence-quest`**. This is the important one:
   Vercel finds the `Dockerfile` there and builds the app as a container (the build log shows
   `▲ container`). Leave *Framework Preset*, *Build Command* and *Output Directory* as they are.
4. **Environment Variables** (add each one; for *Environments* tick **Production** only, so
   test deployments of other branches can never write into the real database):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string from step 1 (exactly this name) |
   | `ADMIN_TOKEN` | a long random password for the status page, at least 16 characters. Make one with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` or type 30+ random characters |
   | `ALLOCATION_SEED` | any word you write down, e.g. `cq-study-2026`. It makes the group allocation reproducible |

   Do **not** set `PORT` or `NODE_ENV`: the `Dockerfile` already sets them (port 80, production),
   and port 80 is where Vercel sends the traffic.
5. Press **Deploy**. The build takes 1-3 minutes and ends with the container being pushed.
6. **Match the database region:** *Settings → Functions → Function Region* → the same region as
   Neon (**Singapore, `sin1`**, if you followed step 1), *Save*, then *Deployments* → the latest
   one → **⋯ → Redeploy**. Without this the app runs in Washington, D.C., and every click
   waits for several round trips to Singapore.

If you add or change an environment variable later, **redeploy** (step 6's last part): running
copies keep the old values until then.

## Step 4: Check it works

1. Open `https://<your-project>.vercel.app/healthz`. You should see `{"ok":true,"storage":"postgres",...}`.
2. Open `https://<your-project>.vercel.app/admin` and enter your `ADMIN_TOKEN`.
   - *Data is stored in:* **Cloud Postgres database (ep-....neon.tech)**.
   - Mode: **LIVE**. Live participants: 0.
3. In Neon, open **Tables**: you should see `participants`, `survey_responses`, and the rest (empty).

## Step 5: Pilot, then clean up

1. Status page → **Switch to PILOT mode**.
2. Have 5-8 classmates do the whole study with the link. Check the **Pilot exports**.
3. Do a full rehearsal on this same setup.
4. Status page → **Delete pilot data** (type `DELETE PILOT DATA`), then **Switch to LIVE mode**.
5. Content changes after this (texts in `server/content/*.json`) mean a new deploy: merge into
   `main`, Vercel rebuilds automatically, and the change is logged in the data. Code freeze
   48 hours before the study.

## Step 6: On the day

- **Wake the app 10 minutes early.** Vercel stops the app after about 5 minutes without
  visitors; the next visitor waits a few seconds while it starts again. Open the participant
  link once, then keep the **status page open on the tech laptop**: it refreshes every
  5 seconds, which keeps the app awake for the whole session.
- **Do not merge anything into `main` during a session.** A merge starts a new deploy, and
  participants could end the study on a different version from the one they started on.
- **Backups:** status page → *Download full backup* before and after each session, plus the CSV exports.
- Share the link as a QR code or a short link.

## Free plan limits

| Limit | Free plan | This study |
|---|---|---|
| Neon storage | 0.5 GB | ~50 participants × ~100 rows each: well under 5 MB |
| Neon compute | sleeps after 5 min idle, wakes in under a second | Not noticeable |
| Vercel | stops the app after ~5 min idle; a few seconds to start again | Keep the status page open during sessions |
| Vercel | no permanent disk; copies of the app come and go | Nothing is stored there; all data is in Neon |

Plans and limits change, and Vercel's Hobby plan is for personal, non-commercial projects
(a student research study fits). If anything is different when you sign up, the app does
not care: any Postgres connection string works in `DATABASE_URL`.

## If something goes wrong

Build problems are in *Deployments → (the deployment) → Building*; problems while running are
in the project's **Logs** tab.

| What you see | What to do |
|---|---|
| Build log: `No prebuilt binaries found (target=20...)` then `Could not find any Python installation` | The deployment used the old `Dockerfile` (Node 20). Merge the latest branch into `main` (step 2) and redeploy |
| Logs: `Refusing to start: this host has no permanent disk. Set DATABASE_URL` | The variable is missing, has a different name, or is not ticked for *Production*. Fix it in *Settings → Environment Variables*, then redeploy |
| Logs: `Refusing to start: set ADMIN_TOKEN` | `ADMIN_TOKEN` must be at least 16 characters |
| Logs: `password authentication failed` or `getaddrinfo ENOTFOUND` | The connection string is wrong or incomplete. Copy it again from Neon → Connect |
| Logs: `Refusing to start. Content check failed: ...` | A file in `server/content/` has a mistake; the message names the file and field |
| `502 Bad Gateway` | A `PORT` variable was added in Vercel. Delete it (or set it to `80`) and redeploy |
| Every click takes a second or more | The Vercel region does not match Neon's; see step 3.6 |
| Status page asks for the token again | Wrong token; it is the `ADMIN_TOKEN` value from Vercel |

## Alternative: Render

Render's free web service runs the app without Docker. Use the same Neon database (step 1), then:

1. **https://render.com** → sign up with GitHub → **New → Web Service** → `leetcode-psych-experiment`.
2. Region **Singapore**, Branch `main`, Root Directory `confidence-quest`, Runtime Node,
   Build Command `npm ci`, Start Command `npm start`, Instance Type **Free**.
3. Environment variables: `DATABASE_URL`, `ADMIN_TOKEN`, `ALLOCATION_SEED` as above, plus
   `NODE_ENV` = `production`. *Settings → Health Check Path:* `/healthz`.
4. A free Render service sleeps after 15 minutes without visitors and takes about a minute to
   wake: open the link early and keep the status page open. Turn *Auto-Deploy* off for the day.

**Supabase** instead of Neon: create a project, then *Connect → Session pooler* and copy that
URI. If the app logs a certificate error, change `sslmode=require` at the end of the URL to
`sslmode=no-verify`. Free Supabase projects pause after a week without use; open the project
dashboard before the study day.

**No internet in the room:** run it on one laptop on the room's Wi-Fi (`npm start`, no
`DATABASE_URL`, data in `data/app.sqlite`). See the README, *Laptop fallback*.
