-- GTV hub community profiles and following
-- Safe to run in the Supabase SQL Editor. This does not modify the existing
-- profiles/profile_data tables used by the household viewing-profile system.

create table if not exists public.community_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    username text,
    display_name text not null default '',
    bio text not null default '',
    avatar_id integer not null default 1,
    is_public boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint community_profiles_username_format
        check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
    constraint community_profiles_display_name_length
        check (char_length(display_name) <= 40),
    constraint community_profiles_bio_length
        check (char_length(bio) <= 160),
    constraint community_profiles_avatar_id_positive
        check (avatar_id > 0)
);

create unique index if not exists community_profiles_username_lower_unique
    on public.community_profiles (lower(username))
    where username is not null;

create index if not exists community_profiles_public_created_idx
    on public.community_profiles (created_at desc)
    where is_public = true;

create table if not exists public.follows (
    follower_id uuid not null references public.community_profiles(user_id) on delete cascade,
    following_id uuid not null references public.community_profiles(user_id) on delete cascade,
    created_at timestamptz not null default now(),
    constraint follows_pkey primary key (follower_id, following_id),
    constraint follows_no_self_follow check (follower_id <> following_id)
);

create index if not exists follows_following_created_idx
    on public.follows (following_id, created_at desc);

create index if not exists follows_follower_created_idx
    on public.follows (follower_id, created_at desc);

alter table public.community_profiles enable row level security;
alter table public.follows enable row level security;

-- Public profiles are readable by guests; private profiles are visible only
-- to their owner. No authenticated user can read private profiles belonging
-- to someone else.
drop policy if exists "Community profiles are visible when public or owned" on public.community_profiles;
create policy "Community profiles are visible when public or owned"
    on public.community_profiles
    for select
    using (is_public = true or user_id = (select auth.uid()));

drop policy if exists "Users can create their own community profile" on public.community_profiles;
create policy "Users can create their own community profile"
    on public.community_profiles
    for insert
    to authenticated
    with check (user_id = (select auth.uid()));

drop policy if exists "Users can update their own community profile" on public.community_profiles;
create policy "Users can update their own community profile"
    on public.community_profiles
    for update
    to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));

-- Follow relationships are visible when both people have public profiles,
-- or to either participant. This supports public counts/lists while keeping
-- relationships involving private profiles private.
drop policy if exists "Follow relationships are visible to participants or public visitors" on public.follows;
create policy "Follow relationships are visible to participants or public visitors"
    on public.follows
    for select
    using (
        follower_id = (select auth.uid())
        or following_id = (select auth.uid())
        or (
            exists (
                select 1 from public.community_profiles follower
                where follower.user_id = follows.follower_id
                  and follower.is_public = true
            )
            and exists (
                select 1 from public.community_profiles followed
                where followed.user_id = follows.following_id
                  and followed.is_public = true
            )
        )
    );

drop policy if exists "Users can follow public community profiles" on public.follows;
create policy "Users can follow public community profiles"
    on public.follows
    for insert
    to authenticated
    with check (
        follower_id = (select auth.uid())
        and follower_id <> following_id
        and exists (
            select 1 from public.community_profiles target
            where target.user_id = follows.following_id
              and target.is_public = true
        )
    );

drop policy if exists "Users can unfollow from their own account" on public.follows;
create policy "Users can unfollow from their own account"
    on public.follows
    for delete
    to authenticated
    using (follower_id = (select auth.uid()));

-- Keep updated_at current when a profile is edited.
create or replace function public.set_community_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists set_community_profile_updated_at on public.community_profiles;
create trigger set_community_profile_updated_at
before update on public.community_profiles
for each row execute function public.set_community_profile_updated_at();

-- Ensure API roles can access the tables; RLS remains the authorization layer.
grant select, insert, update on public.community_profiles to authenticated;
grant select on public.community_profiles to anon;
grant select, insert, delete on public.follows to authenticated;
grant select on public.follows to anon;
