-- GTV hub community activity feed
-- Run this once in the Supabase SQL Editor.

create table if not exists public.community_activity (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    activity_type text not null check (activity_type in ('watching', 'watched', 'recommendation', 'update')),
    message text not null check (char_length(btrim(message)) between 1 and 280),
    created_at timestamptz not null default now()
);

create index if not exists community_activity_user_created_idx
    on public.community_activity (user_id, created_at desc);

create index if not exists community_activity_created_idx
    on public.community_activity (created_at desc);

alter table public.community_activity enable row level security;

drop policy if exists "Public can read activity from public profiles" on public.community_activity;
create policy "Public can read activity from public profiles"
    on public.community_activity
    for select
    to anon, authenticated
    using (
        exists (
            select 1
            from public.community_profiles profile
            where profile.user_id = community_activity.user_id
              and profile.is_public = true
              and profile.username is not null
        )
    );

drop policy if exists "Users can post to their public community profile" on public.community_activity;
create policy "Users can post to their public community profile"
    on public.community_activity
    for insert
    to authenticated
    with check (
        auth.uid() = user_id
        and exists (
            select 1
            from public.community_profiles profile
            where profile.user_id = auth.uid()
              and profile.is_public = true
              and profile.username is not null
        )
    );

drop policy if exists "Users can delete their own activity" on public.community_activity;
create policy "Users can delete their own activity"
    on public.community_activity
    for delete
    to authenticated
    using (auth.uid() = user_id);

grant select on public.community_activity to anon, authenticated;
grant insert, delete on public.community_activity to authenticated;
