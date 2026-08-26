# Deploying this fork

Written for the deployment this repository actually points at: a Linux host running
the daemon from source, with the database on local disk. `scripts/check-history.py`
reads `/etc/opentrader/admin-password.env` and `/root/.hermes/.opentrader.env`, and
`AGENTS.md` names `https://ai.omniware.dk` — so this is a bare-metal install, not the
published Docker image.

> **The daemon places real orders.** Every step below assumes you can stop it, look
> at what it is holding, and start it again. Read [Rollback](#rollback) first.

---

## Before the first deploy of this change set

This release changes three things that are not code, and each one needs a decision
before it lands.

### 1. Dependencies are pinned now

`.npmrc` used to set `lockfile=false`, which meant pnpm neither read nor wrote
`pnpm-lock.yaml`. Every install resolved the semver ranges in `package.json` afresh,
so two builds of the same commit could ship different versions of `ccxt`, `fastify`
or the Prisma client.

It is now `lockfile=true`, and the lockfile is committed. Consequences:

- `pnpm install` in CI defaults to `--frozen-lockfile`. Adding a dependency now means
  committing the updated lockfile with it, or the build fails.
- The first install after this change may move some versions, because it is applying
  the lockfile rather than resolving freely. **Run the test suite after installing on
  the target host**, not just locally.

### 2. The `AiAction` table

The AI action feed is a 500-entry in-process ring. It now also writes through to an
`AiAction` table so the feed survives a restart.

Apply it the way this fork applies schema changes:

```bash
pnpm --filter @opentrader/prisma exec prisma db push
```

**Not `prisma migrate deploy`.** This database has no `_prisma_migrations` rows for
`RegimePolicy`, `RegimeConviction`, `LearningJournal` or `AiSettings` either — they
were all created with `db push`, and `migrate deploy` would try to recreate tables
that already exist. The README says the same thing in its indexing section.

If you skip this step nothing breaks. The daemon logs one warning and runs the feed
in memory only, exactly as it did before.

### 3. The AI can act on its own, if you arm it

The chat proposes; you approve. Arming **Autopilot** in the chat widget lets approved
proposals run without asking each time. Before the first deploy where anyone might
arm it, set a ceiling:

```bash
AI_AUTONOMOUS_MAX_ACTIONS=20     # per rolling window, enforced on the server
AI_AUTONOMOUS_WINDOW_MS=1800000  # 30 minutes
AI_DAILY_TOKEN_BUDGET=500000     # 0 means no ceiling; a stuck loop bills at full speed
```

The dashboard shows a matching countdown, but that copy lives in a browser tab. The
server's is the one that decides.

---

## Deploy

```bash
# 1. On the host, from the checkout
git fetch && git status          # confirm nothing local is about to be lost
pnpm install --frozen-lockfile
pnpm --filter @opentrader/prisma exec prisma generate

# 2. Verify before restarting anything
pnpm typecheck
pnpm lint
pnpm exec vitest run

# 3. Schema (see above — db push, not migrate deploy)
cp "$DATABASE_FILE" "$DATABASE_FILE.$(date +%Y%m%d%H%M%S).bak"
pnpm --filter @opentrader/prisma exec prisma db push

# 4. Restart the daemon by whatever supervises it
systemctl restart opentrader     # or your equivalent

# 5. RESTART THE BOTS. Read the section below before skipping this.
```

### Restarting the daemon disables your bots

This is the single most important thing on this page, and it is not obvious.

On shutdown the daemon logs `Stopping 8 bots gracefully…` and persists
`enabled = 0` for each one. **On startup it does not re-enable them.** In practice
one or two come back and the rest do not, so a post-restart glance at the
dashboard looks plausible while most of the fleet is quietly not trading.

Observed on a real deploy: 8 of 8 enabled before, 2 of 8 after.

```bash
# Before restarting, record what was enabled
sqlite3 "$DB" 'select id, name, enabled from Bot order by id;'

# After restarting, compare — and start anything that came back disabled
for id in $(sqlite3 "$DB" 'select id from Bot where enabled = 0;'); do
  curl -s -X POST -H "Authorization: $ADMIN_PASSWORD" \
       -H 'content-type: application/json' -d "{\"botId\":$id}" \
       "http://[::1]:8000/api/dash/actions/bot.start"
  sleep 2
done
```

`bot.start` on an already-running bot returns `409 Bot already running`, which is
harmless — so the loop is safe to run over every bot if you would rather not
diff.

**What this does not do is strand your positions.** A daemon shutdown is not the
same as the operator "Stop" button: it does not cancel the take-profit orders
resting on the exchange. Those are the exchange's, not the daemon's, and they keep
working the whole time the process is down. Verified across two restarts —
`GET /positions/stranded` returned 0 both times. Check it yourself anyway:

```bash
curl -s -H "Authorization: $ADMIN_PASSWORD" \
  "http://[::1]:8000/api/dash/positions/stranded"
```

### Read the preflight block

The daemon now prints its configuration warnings at boot, before anything trades:

```
[Preflight] 2 configuration warnings:
[Preflight]   network.public: Listening on 0.0.0.0. The admin password travels as a
              plain Authorization header ... put a reverse proxy in front of it
[Preflight]   database.permissions: /app/data/dev.db is readable by other users on
              this host (mode 644). It stores exchange API keys ... chmod 600 it
```

These are warnings, never refusals — a daemon that will not start is a daemon not
managing open positions, which is worse than the thing it objected to. But they are
the checks worth acting on, and `network.public` in particular is not optional: the
admin password is sent as a plain header on every request and kept in browser
localStorage. **Terminate TLS in front of this. Do not expose the port directly.**

---

## Verify the deploy

```bash
# The AI surface, end to end
python scripts/check-history.py

# What the guards currently allow
curl -H "Authorization: $ADMIN_PASSWORD" localhost:8000/api/dash/ai/status

# Health, which now includes the AI checks
curl -H "Authorization: $ADMIN_PASSWORD" localhost:8000/api/dash/health | jq '.status, .counts'
```

Then open the dashboard and confirm:

- The tab bar is there and your old board is on the **first tab, unchanged**. If it is
  not, see [Rollback](#rollback) — the pre-tabs layout is still in localStorage.
- **AI settings → Fetch models** lists models, and the **Free** chip narrows them.
- The **AI** tab shows the action window; it should already hold history if you ran
  `db push`.
- The bottom bar has two lanes.

---

## Rollback

| What went wrong | What to do |
|---|---|
| **Bots are not trading after a restart** | Expected — see [above](#restarting-the-daemon-disables-your-bots). Start each one that came back `enabled = 0`. |
| Daemon will not start | `systemctl stop opentrader`, `git checkout <previous-sha>`, `pnpm install --frozen-lockfile`, `pnpm build`, restart, then start the bots. The `AiAction` table is additive — leaving it in place is harmless. |
| Build fails with `spawnSync … moon ENOENT` | pnpm skipped `@moonrepo/cli`'s postinstall. `pnpm rebuild @moonrepo/cli esbuild ccxt`, then build again. `onlyBuiltDependencies` in `pnpm-workspace.yaml` prevents it on a fresh install, but does not retroactively fix an existing tree. |
| A bot is misbehaving after restart | Stop that bot from the dashboard. Stopping cancels its resting exit orders, so check `GET /api/dash/positions/stranded` afterwards and use `position.recoverStranded`. |
| The AI is doing something you did not expect | `POST /api/dash/actions/ai.disable`. This stops the AI and **leaves your own controls working** — unlike `/actions/freeze`, which disables agent control entirely including the buttons you would use to clean up. |
| Autopilot ran away | It cannot: the server caps unattended actions per window and disarms on the first failure. `ai.disable` stops it immediately regardless. |
| Someone's board looks wrong | The pre-tabs layout is still under `otAnalytics.layout.v1` in their browser's localStorage. The migration reads it and never deletes it. |
| Database is wrong | Restore the `.bak` taken in step 3, then restart. |

Images are tagged by commit as well as `latest`, so a Docker rollback targets a
specific build rather than whatever `latest` meant at the time.

---

## What is still not done

Honest list, so nobody discovers these the hard way.

- **The admin password is the only credential.** It is stored in browser localStorage
  and sent as a plain `Authorization` header. There are no accounts, no rotation, no
  expiry. TLS in front is doing all the work.
- **Provider and exchange API keys are plain text in SQLite.** `chmod 600` the file
  and keep it off shared hosts. The preflight check will tell you if it is readable.
- **`pro/` is a private submodule.** `pro.Dockerfile` clones it with a `GITHUB_TOKEN`
  build arg, which writes the token into `/root/.gitconfig` in an intermediate layer.
  The final image does not carry it, but a BuildKit secret mount would be better.
- **The two executor test suites are skipped**, not passing. They need a seeded
  database and they place real orders. Run them deliberately with
  `OPENTRADER_INTEGRATION=1`, somewhere it is safe to trade from.
- **No metrics backend.** Token spend, model latency and autopilot actions are logged
  and exposed on `/api/dash/ai/status`, but nothing scrapes them.
