-- Communitys, Einladungen und Sichtbarkeit pro Fund (community / alle / privat)
-- Stand wie in der Datenbank angewendet (Migration communities_sichtbarkeit + hilfsfunktionen_intern).

create schema if not exists intern;
grant usage on schema intern to authenticated;

create table public.communities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 80),
  beschreibung text check (char_length(beschreibung) <= 500),
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.mitglieder (
  community_id uuid not null references public.communities (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  rolle text not null default 'mitglied' check (rolle in ('admin', 'mitglied')),
  created_at timestamptz not null default now(),
  primary key (community_id, user_id)
);
create table public.einladungen (
  code text primary key default encode(extensions.gen_random_bytes(9), 'hex'),
  community_id uuid not null references public.communities (id) on delete cascade,
  created_by uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  gueltig_bis timestamptz not null default now() + interval '30 days',
  max_nutzungen integer check (max_nutzungen > 0),
  nutzungen integer not null default 0,
  created_at timestamptz not null default now()
);

-- intern.ist_mitglied(c), intern.ist_admin(c): security definer, prüfen Mitgliedschaft der angemeldeten Person
-- public.community_beitreten(code): security definer, Beitritt per Einladungscode
-- Trigger community_gruender: Gründer*in wird Admin

alter table public.funde
  add column sichtbarkeit text not null default 'community' check (sichtbarkeit in ('community', 'alle', 'privat')),
  add column community_id uuid references public.communities (id) on delete set null;

-- Lesen von Funden: eigene ODER sichtbarkeit = 'alle' ODER (sichtbarkeit = 'community' und Mitglied)
-- Kommentare und Fotos: nur zu Funden, die man sehen darf
-- Communitys/Mitglieder: nur für Mitglieder sichtbar; Rollen ändern, entfernen, einladen: nur Admins; austreten: jede*r selbst
