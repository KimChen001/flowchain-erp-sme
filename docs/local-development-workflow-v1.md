# Local development workflow v1

FlowChain local development is an explicit, fail-closed workflow. It only runs when `NODE_ENV=development`, `FLOWCHAIN_DEV_LOCAL=true`, and `DATABASE_URL` targets PostgreSQL on `localhost`, `127.0.0.1`, or `::1`.

## Start

First start:

```powershell
Copy-Item .env.local.example .env.local
npm run dev:local -- --demo
```

Daily start:

```powershell
npm run dev:local
```

Full local scenario:

```powershell
npm run dev:local -- --scenario
```

The launcher loads `.env.local`, verifies the database boundary and connection through Prisma, generates the client, deploys migrations, provisions the Pilot workspace, optionally loads explicit demo data, starts the API, waits for health, and starts Vite. Ctrl+C stops both child processes.

The launcher creates strong session and sync secrets once in `.local/generated.env`; that file is ignored and reused. Production never receives generated defaults.

Use a database and artifact directory dedicated to each worktree. The recommended database for this worktree is `flowchain_54b1`; do not point it at another worktree or a remote database. Change `SCM_API_PORT`, `VITE_API_ORIGIN`, or the Vite `--port` setting if another worktree already owns a port.

Local accounts are `admin@flowchain.local` and `kim@example.com`. They exist only after `pilot:setup`. The login API never creates users.

To reset demo data, remove only records with the `LOCAL-DEMO-` prefix from the dedicated local database after stopping the app, then rerun the explicit seed. The launcher never wipes data.
