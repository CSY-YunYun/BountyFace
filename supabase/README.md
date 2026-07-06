# Supabase Setup

BountyFace uses Supabase's default `public` schema for persistent target
profiles and 256-dimensional face embeddings. Raw scan images are never stored.

## Local database and web Studio

Docker Desktop must be running. From the repository root:

```bash
npx --yes supabase start
```

The CLI applies every file in `supabase/migrations` automatically. Open the
local database UI at:

```text
http://127.0.0.1:54323
```

In Studio, select **Table Editor > public** to inspect `targets` and
`target_embeddings`. This local Studio has no login screen and is for
development only.

To connect FastAPI to the local stack, run `npx --yes supabase status -o env`
and copy its local API URL and secret/service-role key into the ignored
`server/.env`:

```dotenv
STORAGE_BACKEND=supabase
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=the_local_secret_key_from_supabase_status
```

Useful commands:

```bash
npx --yes supabase status
npx --yes supabase db reset
npx --yes supabase stop
```

`db reset` deletes local rows and reapplies migrations/seed data. `stop` keeps
the local Docker data for the next start unless destructive flags are supplied.

## Hosted project: create the schema

1. Open [Supabase Dashboard](https://supabase.com/dashboard) and select the project.
2. Open **SQL Editor** and choose **New query**.
3. Paste the contents of
   [`migrations/202607060001_step7_targets_pgvector.sql`](migrations/202607060001_step7_targets_pgvector.sql).
4. Select **Run** once.

The migration creates:

- `public.targets`
- `public.target_embeddings`
- a cosine-distance HNSW index
- `match_target_embeddings` and `add_target_embedding` database functions
- RLS with no client-side access policies

The vector is `vector(256)`, matching the bundled MobileFaceNet model. Do not
change it to 512 unless the on-device model is replaced with a 512-output model.

## Hosted project: configure the backend

In **Project Settings > API**, copy the project URL and server-only service-role
key into `server/.env`:

```dotenv
STORAGE_BACKEND=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Never place the service-role key in `frontend/`, Expo config, or Git. Restart
FastAPI after changing `.env`, then verify:

```bash
curl http://localhost:8000/health
```

The response must contain `"storage":"supabase"` and
`"embeddingDimension":256`. Keep `STORAGE_BACKEND=memory` for temporary local
storage and tests; change it to `supabase` only after running the migration.

## Hosted project: view stored data

1. Open **Table Editor** in the project dashboard.
2. Select the `public` schema.
3. Open `targets` to view names and persistent RPG base stats.
4. Open `target_embeddings` to view each target's embedding variants, source,
   quality score, and creation time.

Use **SQL Editor** to inspect row counts and the index:

```sql
select count(*) as targets from public.targets;
select count(*) as embeddings from public.target_embeddings;

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'target_embeddings';
```

Expected first-device test:

1. First scan returns `matchStatus: "new"` and inserts one row in each table.
2. Restart FastAPI.
3. Scan the same person again; `/v1/scan` returns the original `targetId`.
4. The current photo is analyzed again for equipment, style, pose, and
   `current_power`; base stats remain unchanged.
