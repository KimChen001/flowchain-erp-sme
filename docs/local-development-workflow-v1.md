# Local development workflow v1

FlowChain local development is an explicit, fail-closed workflow. It only runs when `NODE_ENV=development`, `FLOWCHAIN_DEV_LOCAL=true`, and `DATABASE_URL` targets PostgreSQL on `localhost`, `127.0.0.1`, or `::1`.

## Start

First start:

```powershell
Copy-Item .env.local.example .env.local
npm run dev:local -- --public-data
```

Daily start:

```powershell
npm run dev:local
```

Public data from UCI Online Retail II instead of M5:

```powershell
npm run dev:local -- --public-data=uci
```

`--public-data` seeds the workspace once, while it is still empty, from the local extract described in [Public data workspaces](public-data-workspaces.md).

The launcher loads `.env.local`, verifies the database boundary and connection through Prisma, generates the client, deploys migrations, provisions the Pilot workspace, optionally seeds public data, starts the API, waits for health, and starts Vite. Ctrl+C stops both child processes.

The launcher creates strong session and sync secrets once in `.local/generated.env`; that file is ignored and reused. Production never receives generated defaults.

Use a database and artifact directory dedicated to each worktree. The recommended database for this worktree is `flowchain_54b1`; do not point it at another worktree or a remote database. Change `SCM_API_PORT`, `VITE_API_ORIGIN`, or the Vite `--port` setting if another worktree already owns a port.

Local accounts are `admin@flowchain.local` and `kim@example.com`. They exist only after `pilot:setup`. The login API never creates users.

To start over with public data, drop and recreate the dedicated local database after stopping the app, then run `npm run dev:local -- --public-data` again. The launcher never wipes data.
