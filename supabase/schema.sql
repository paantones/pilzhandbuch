-- Pilzhandbuch: Profile, Funde, Kommentare, Foto-Speicher
-- Alle angemeldeten Mitglieder sehen alles; ändern darf jede*r nur Eigenes.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 60),
  created_at timestamptz not null default now()
);

create table public.funde (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  art_id integer,                 -- Nummer der Art im App-Register
  art_lat text,                   -- wissenschaftlicher Name (stabil, unabhängig vom Register)
  art_de text,
  art_frei text check (char_length(art_frei) <= 120),  -- Art, die nicht im Buch steht
  unsicher boolean not null default false,
  datum date not null default current_date,
  lat double precision check (lat between -90 and 90),
  lon double precision check (lon between -180 and 180),
  genauigkeit real,
  ort text check (char_length(ort) <= 300),
  notiz text check (char_length(notiz) <= 5000),
  fotos text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index funde_user_idx on public.funde (user_id);
create index funde_datum_idx on public.funde (datum desc, created_at desc);
create index funde_art_idx on public.funde (art_id);

create table public.kommentare (
  id uuid primary key default gen_random_uuid(),
  fund_id uuid not null references public.funde (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index kommentare_fund_idx on public.kommentare (fund_id, created_at);
create index kommentare_user_idx on public.kommentare (user_id);

-- Profil automatisch bei Registrierung anlegen
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name)
  values (new.id, left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'name'), ''), split_part(new.email, '@', 1)), 60));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at pflegen
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger funde_touch before update on public.funde
  for each row execute function public.touch_updated_at();

-- Zeilenrechte
alter table public.profiles enable row level security;
alter table public.funde enable row level security;
alter table public.kommentare enable row level security;

create policy "Mitglieder sehen Profile" on public.profiles for select to authenticated using (true);
create policy "Eigenes Profil ändern" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "Mitglieder sehen Funde" on public.funde for select to authenticated using (true);
create policy "Eigene Funde anlegen" on public.funde for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Eigene Funde ändern" on public.funde for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Eigene Funde löschen" on public.funde for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Mitglieder sehen Kommentare" on public.kommentare for select to authenticated using (true);
create policy "Kommentieren" on public.kommentare for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Eigene Kommentare löschen" on public.kommentare for delete to authenticated using ((select auth.uid()) = user_id);

-- Fotos: privater Bucket, Ordner je Person
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

create policy "Mitglieder sehen Fotos" on storage.objects for select to authenticated using (bucket_id = 'fotos');
create policy "Eigene Fotos hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Eigene Fotos ändern" on storage.objects for update to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Eigene Fotos löschen" on storage.objects for delete to authenticated
  using (bucket_id = 'fotos' and (storage.foldername(name))[1] = (select auth.uid())::text);
