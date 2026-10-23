-- =====================================================================
-- Coachpilot – database, beveiliging en foto-opslag
-- Plak dit volledige bestand in Supabase > SQL Editor > New query > Run.
-- Je kunt het veilig vaker uitvoeren.
-- =====================================================================

-- 1. Eén tabel voor alle app-gegevens (profielen, berichten, reviews, …)
create table if not exists public.docs (
  path       text primary key,                 -- bv. posts/abc of posts/abc/replies/xyz
  coll       text not null,                    -- bv. posts of posts/abc/replies
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint docs_path_ok check (path = coll || '/' || id)
);
create index if not exists docs_coll_idx on public.docs (coll);
create index if not exists docs_notif_to_idx on public.docs ((data->>'to')) where coll = 'notifications';

-- 2. Moderators
create table if not exists public.moderators (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function public.is_mod() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.moderators where user_id = auth.uid());
$$;

create or replace function public.me() returns text
language sql stable as $$ select coalesce(auth.uid()::text, '') $$;

-- 3. Beveiliging (Row Level Security)
alter table public.docs enable row level security;
alter table public.moderators enable row level security;

drop policy if exists moderators_read on public.moderators;
create policy moderators_read on public.moderators for select using (true);

drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select using (
  case
    when coll = 'notifications' then data->>'to' = public.me()
    when coll = 'reports'       then public.is_mod()
    when coll = 'submissions'   then public.is_mod() or data->>'by' = public.me()
    when coll like 'data/%'     then coll = 'data/users/' || public.me()
    else true
  end
);

drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated with check (
  case
    when coll = 'profiles'               then id = public.me()
    when coll = 'usernames'              then data->>'accountId' = public.me() or public.is_mod()
    when coll = 'posts'                  then data->>'author' = public.me()
    when coll like 'posts/%/replies'     then data->>'author' = public.me()
    when coll = 'reviews'                then data->>'author' = public.me()
    when coll = 'reports'                then data->>'by' = public.me()
    when coll = 'submissions'            then data->>'by' = public.me()
    when coll = 'notifications'          then data->>'from' = public.me()
    when coll in ('parkings','companies','modOverrides','categories','news') then public.is_mod()
    when coll = 'hangout'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'data/users/' || public.me() then true
    else false
  end
);

drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
using (
  case
    when coll = 'profiles'               then id = public.me()
    when coll = 'usernames'              then data->>'accountId' = public.me() or public.is_mod()
    when coll = 'posts' or coll like 'posts/%/replies' then true   -- trigger hieronder bewaakt wát er mag veranderen
    when coll = 'reviews'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'submissions'            then public.is_mod()
    when coll = 'notifications'          then data->>'to' = public.me()
    when coll in ('parkings','companies','modOverrides','categories','news') then public.is_mod()
    when coll = 'hangout'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'data/users/' || public.me() then true
    else false
  end
)
with check (
  case
    when coll = 'profiles'               then id = public.me()
    when coll = 'usernames'              then data->>'accountId' = public.me() or public.is_mod()
    when coll = 'posts' or coll like 'posts/%/replies' then true
    when coll = 'reviews'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'submissions'            then public.is_mod()
    when coll = 'notifications'          then data->>'to' = public.me()
    when coll in ('parkings','companies','modOverrides','categories','news') then public.is_mod()
    when coll = 'hangout'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'data/users/' || public.me() then true
    else false
  end
);

drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (
  case
    when coll = 'posts' or coll like 'posts/%/replies' then data->>'author' = public.me() or public.is_mod()
    when coll = 'reviews'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'usernames'              then data->>'accountId' = public.me() or public.is_mod()
    when coll = 'notifications'          then data->>'to' = public.me()
    when coll in ('reports','parkings','companies','modOverrides','submissions','categories','news') then public.is_mod()
    when coll = 'hangout'                then data->>'author' = public.me() or public.is_mod()
    when coll = 'data/users/' || public.me() then true
    else false
  end
);

-- Berichten: iedereen mag duimpjes/reactietellers bijwerken,
-- maar alleen de schrijver of een moderator mag de inhoud aanpassen.
create or replace function public.docs_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.path <> old.path or new.coll <> old.coll or new.id <> old.id then
    raise exception 'Het pad van een document kan niet veranderen';
  end if;
  if (new.coll = 'posts' or new.coll like 'posts/%/replies' or new.coll = 'reviews') and not public.is_mod() then
    if new.data->>'author' is distinct from old.data->>'author' then
      raise exception 'De schrijver van een bericht kan niet veranderen';
    end if;
    if coalesce(old.data->>'author','') <> public.me()
       and (new.data - 'likes' - 'replyCount' - 'lastAt') is distinct from (old.data - 'likes' - 'replyCount' - 'lastAt') then
      raise exception 'Alleen de schrijver of een moderator mag dit bericht aanpassen';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before update on public.docs
  for each row execute function public.docs_guard();

-- Toegang voor de app
grant select on public.docs, public.moderators to anon, authenticated;
grant insert, update, delete on public.docs to authenticated;
grant execute on function public.is_mod(), public.me() to anon, authenticated;

-- 4. Live bijwerken (realtime)
alter table public.docs replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;

-- 5. Foto-opslag (max. 5 MB, alleen afbeeldingen)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uploads', 'uploads', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "uploads lezen" on storage.objects;
create policy "uploads lezen" on storage.objects for select using (bucket_id = 'uploads');

drop policy if exists "uploads in eigen map" on storage.objects;
create policy "uploads in eigen map" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- Klaar. Jezelf moderator maken? Registreer eerst in de app, en voer dan uit
-- (met jouw e-mailadres):
--
--   insert into public.moderators (user_id)
--   select id from auth.users where email = 'JOUW@EMAIL.NL'
--   on conflict do nothing;
-- =====================================================================
