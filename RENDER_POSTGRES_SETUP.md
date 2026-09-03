# Fixing Render data loss: switching to Postgres

## Why this happened

Render's **free** web service tier does not actually give you a persistent disk, even though `render.yaml` had a `disk:` block. That block only takes effect on paid plans. On the free tier, `/var/data` (and therefore the old SQLite database file and all uploaded avatars) got wiped every time the service spun down from inactivity and restarted — which looks exactly like "it forgot everything and launched a clean copy."

## What changed

- The app's database is now **Postgres** instead of a SQLite file on disk. Render's free Postgres databases are separate from your web service and are not wiped when the web service sleeps/restarts.
- Avatars and server icons are now stored directly inside Postgres (as embedded image data), so they persist along with everything else, with no separate storage service needed.
- Large file-sharing uploads (the "share a big file" feature) still use local disk and will still be lost on restart, exactly like before — but that feature already auto-deletes files after a few hours regardless, so nothing meaningful changes there.
- `package.json` no longer depends on `better-sqlite3`.
- `render.yaml` now provisions a free Render Postgres database and wires its connection string into your web service automatically.

This was tested locally against a real Postgres database, including killing and restarting the server process mid-test — accounts, servers, messages (with edits/deletes), and avatars all survived the restart intact.

## Deploying: step by step

### 1. Push these updated files to your GitHub repo

Make sure `server.js`, `package.json`, and `render.yaml` (all just updated in your `Discord-main` folder) are committed and pushed to the `purpleeds/Ture` repository — or whichever repo Render is deploying from.

### 2. Delete your existing Render web service (recommended) or update it

Because the database setup is changing, the cleanest path is:

1. Go to your [Render dashboard](https://dashboard.render.com).
2. Delete the old `socket-chat-render` web service (this does **not** delete your GitHub repo — only the Render deployment).
3. Click **New +** → **Blueprint**.
4. Connect your GitHub repo (`purpleeds/Ture`).
5. Render will read `render.yaml` and show you a plan to create:
   - A **PostgreSQL database** called `chat-db` (free tier)
   - A **web service** called `socket-chat-render`, with `DATABASE_URL` automatically pointed at that database
6. Click **Apply** / **Create**.

Render will provision the database first, then deploy your web service with the connection string already wired in as an environment variable — you don't need to copy/paste anything.

If you'd rather not delete the existing service, you can instead: create the Postgres database manually (**New +** → **PostgreSQL**, free plan), then go to your existing web service's **Environment** tab and add `DATABASE_URL` set to that database's **Internal Connection String** (Render shows this on the database's page). Either path works; the Blueprint route is simpler.

### 3. Wait for the first deploy

The first boot will:

- Connect to Postgres and automatically create all the necessary tables (no manual SQL needed).
- Set up the default `general` server with its `#general`, `#gaming`, `#coding` channels.
- Apply any accounts listed in `SEED_ACCOUNTS` inside `server.js` (Purple is hardcoded as admin regardless of this list).

You'll see `Server running on port ...` in the Render logs when it's ready.

### 4. Verify persistence

Once it's live: register/log in, send a message, set an avatar. Then just wait for Render's free tier to spin the service down from inactivity (or manually restart it from the Render dashboard). When it wakes back up, everything should still be there — that's the whole point of this change.

## A note on Render's free tier

Free Postgres databases on Render are free for 90 days, after which Render either asks you to upgrade or the database is suspended (Render will email you before that happens). If that comes up, you can either upgrade to a paid Postgres plan (a few dollars a month) or create a fresh free database and let the app rebuild its schema — you'd lose existing data in that specific case, but at least it's a one-time, known event tied to Render's free-tier policy rather than something that happens on every restart.

## Manually adding accounts (unchanged)

The `SEED_ACCOUNTS` array near the top of `server.js` still works the same way — add an entry like:

```js
{ username: 'SomeName', password: 'a-strong-password', isAdmin: false }
```

and redeploy. It's applied idempotently on every boot (it won't reset an existing password), so it's safe to leave entries in permanently.
