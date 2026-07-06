create extension if not exists vector with schema extensions;

create table if not exists public.targets (
  id uuid primary key,
  display_name text not null check (char_length(display_name) between 1 and 40),
  special_title text not null default '',
  base_power integer not null check (base_power between 1 and 99999),
  threat_level text not null check (threat_level in ('D', 'C', 'B', 'A', 'S', 'SS')),
  level integer not null check (level between 1 and 100),
  str integer not null check (str between 1 and 100),
  dex integer not null check (dex between 1 and 100),
  int integer not null check (int between 1 and 100),
  luk integer not null check (luk between 1 and 100),
  description text not null check (char_length(description) between 1 and 240),
  is_public_figure boolean not null default false,
  is_verified boolean not null default false,
  is_name_editable boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.target_embeddings (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.targets(id) on delete cascade,
  embedding extensions.vector(256) not null,
  source text not null check (char_length(source) between 1 and 40),
  quality_score real not null default 1 check (quality_score between 0 and 1),
  created_at timestamptz not null default now()
);

create index if not exists target_embeddings_target_id_idx
  on public.target_embeddings (target_id);

create index if not exists target_embeddings_embedding_hnsw_idx
  on public.target_embeddings
  using hnsw (embedding vector_cosine_ops);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists targets_set_updated_at on public.targets;
create trigger targets_set_updated_at
before update on public.targets
for each row execute function public.set_updated_at();

create or replace function public.match_target_embeddings(
  query_embedding extensions.vector(256),
  match_count integer default 1
)
returns table (
  target_id uuid,
  similarity double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    target_embeddings.target_id,
    1 - (target_embeddings.embedding <=> query_embedding) as similarity
  from public.target_embeddings
  order by target_embeddings.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;

create or replace function public.add_target_embedding(
  p_target_id uuid,
  p_embedding extensions.vector(256),
  p_source text,
  p_quality_score real default 1
)
returns integer
language plpgsql
set search_path = public, extensions
as $$
declare
  embedding_count integer;
begin
  insert into public.target_embeddings (
    target_id,
    embedding,
    source,
    quality_score
  ) values (
    p_target_id,
    p_embedding,
    p_source,
    p_quality_score
  );

  delete from public.target_embeddings
  where id in (
    select id
    from public.target_embeddings
    where target_id = p_target_id
    order by created_at desc, id desc
    offset 8
  );

  select count(*) into embedding_count
  from public.target_embeddings
  where target_id = p_target_id;

  return embedding_count;
end;
$$;

alter table public.targets enable row level security;
alter table public.target_embeddings enable row level security;

revoke all on table public.targets from anon, authenticated;
revoke all on table public.target_embeddings from anon, authenticated;
revoke all on function public.match_target_embeddings(extensions.vector, integer) from public, anon, authenticated;
revoke all on function public.add_target_embedding(uuid, extensions.vector, text, real) from public, anon, authenticated;

grant all on table public.targets to service_role;
grant all on table public.target_embeddings to service_role;
grant execute on function public.match_target_embeddings(extensions.vector, integer) to service_role;
grant execute on function public.add_target_embedding(uuid, extensions.vector, text, real) to service_role;
