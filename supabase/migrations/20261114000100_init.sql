-- Refricherator の最初のテーブル。
-- どのテーブルも RLS を有効にしてポリシーを作らない = アプリ(公開用キー)からは読めない。
-- 触れるのは中継サーバー(Edge Function、管理用キー)だけ。

create table public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'その他',
  added_on date not null,
  expires_on date not null,
  gone_at timestamptz,
  created_at timestamptz not null default now()
);
create index items_have_idx on public.items (expires_on) where gone_at is null;

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  scene text not null,
  title text not null,
  lead text not null default '',
  minutes int not null default 0,
  servings int not null default 1,
  ingredients jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  tip text not null default '',
  image_url text,
  cooked_at timestamptz,
  created_at timestamptz not null default now()
);
create index recipes_created_idx on public.recipes (created_at desc);

create table public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.items enable row level security;
alter table public.recipes enable row level security;
alter table public.kv enable row level security;

revoke all on public.items, public.recipes, public.kv from anon, authenticated;

-- 料理写真の置き場所(公開。ファイル名は推測できない ID)
insert into storage.buckets (id, name, public)
values ('dishes', 'dishes', true)
on conflict (id) do nothing;
