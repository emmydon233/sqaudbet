-- SquadBet wallet + Paystack deposit foundation.
-- Apply in Supabase SQL Editor after reviewing your existing wallet/challenge schema.
-- All money values are stored as integer kobo, never floating-point naira.

create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  available_balance_kobo bigint not null default 0 check (available_balance_kobo >= 0),
  reserved_balance_kobo bigint not null default 0 check (reserved_balance_kobo >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.wallets add column if not exists updated_at timestamptz not null default now();

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  user_id uuid not null references auth.users(id) on delete restrict,
  provider text not null check (provider in ('paystack')),
  amount_kobo bigint not null check (amount_kobo >= 50000 and amount_kobo <= 5000000),
  currency text not null default 'NGN' check (currency = 'NGN'),
  status text not null default 'pending' check (status in ('pending','success','failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists payment_transactions_user_created_idx
  on public.payment_transactions (user_id, created_at desc);

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  reference text not null unique,
  entry_type text not null check (entry_type in ('deposit','stake_reserve','stake_release','payout','withdrawal','refund','adjustment')),
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  description text not null,
  created_at timestamptz not null default now()
);

create index if not exists wallet_ledger_user_created_idx
  on public.wallet_ledger (user_id, created_at desc);

alter table public.wallets enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.wallet_ledger enable row level security;

drop policy if exists "Users can read their own wallet" on public.wallets;
create policy "Users can read their own wallet" on public.wallets
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can read their own payment transactions" on public.payment_transactions;
create policy "Users can read their own payment transactions" on public.payment_transactions
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can read their own wallet ledger" on public.wallet_ledger;
create policy "Users can read their own wallet ledger" on public.wallet_ledger
  for select to authenticated using (auth.uid() = user_id);

revoke insert, update, delete on public.wallets from anon, authenticated;
revoke insert, update, delete on public.payment_transactions from anon, authenticated;
revoke insert, update, delete on public.wallet_ledger from anon, authenticated;
grant select on public.wallets, public.payment_transactions, public.wallet_ledger to authenticated;
grant all on public.wallets, public.payment_transactions, public.wallet_ledger to service_role;

-- Called only by trusted server code using the service-role key after Paystack
-- verification or a valid signed webhook. Locks rows and is idempotent.
create or replace function public.credit_wallet_from_paystack(
  p_reference text,
  p_amount_kobo bigint
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tx public.payment_transactions%rowtype;
begin
  if p_reference is null or length(p_reference) > 100 or p_amount_kobo <= 0 then
    raise exception 'Invalid payment parameters';
  end if;

  select * into v_tx
  from public.payment_transactions
  where reference = p_reference and provider = 'paystack'
  for update;

  if not found then raise exception 'Payment reference not found'; end if;
  if v_tx.amount_kobo <> p_amount_kobo then raise exception 'Payment amount mismatch'; end if;
  if v_tx.currency <> 'NGN' then raise exception 'Payment currency mismatch'; end if;

  if v_tx.status = 'success' then
    -- A webhook and the browser verification can arrive for the same payment.
    return;
  end if;
  if v_tx.status <> 'pending' then raise exception 'Payment is not pending'; end if;

  insert into public.wallets (user_id, available_balance_kobo, reserved_balance_kobo)
  values (v_tx.user_id, 0, 0)
  on conflict (user_id) do nothing;

  update public.wallets
  set available_balance_kobo = available_balance_kobo + v_tx.amount_kobo,
      updated_at = now()
  where user_id = v_tx.user_id;

  insert into public.wallet_ledger (user_id, reference, entry_type, amount_kobo, description)
  values (v_tx.user_id, 'deposit:' || v_tx.reference, 'deposit', v_tx.amount_kobo, 'Verified Paystack deposit');

  update public.payment_transactions
  set status = 'success', paid_at = now(), updated_at = now()
  where id = v_tx.id;
end;
$$;

revoke all on function public.credit_wallet_from_paystack(text, bigint) from public, anon, authenticated;
grant execute on function public.credit_wallet_from_paystack(text, bigint) to service_role;

-- Ensure the expected profile table exists. Existing projects keep their table;
-- this statement only creates it when it is absent.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  state text,
  city text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
drop policy if exists "Authenticated users can read profiles" on public.profiles;
create policy "Authenticated users can read profiles" on public.profiles
  for select to authenticated using (true);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

-- Create a wallet and profile when a user is created. Username uniqueness is
-- enforced in the database, not just by the registration form.
create or replace function public.create_squadbet_user_records()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_username text;
begin
  v_username := coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), 'player_' || substr(replace(new.id::text, '-', ''), 1, 12));
  insert into public.profiles (id, username, state, city)
  values (new.id, v_username, nullif(trim(new.raw_user_meta_data ->> 'state'), ''), nullif(trim(new.raw_user_meta_data ->> 'city'), ''))
  on conflict (id) do nothing;
  insert into public.wallets (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_wallet on auth.users;
drop trigger if exists on_auth_user_created_squadbet_records on auth.users;
create trigger on_auth_user_created_squadbet_records
after insert on auth.users
for each row execute procedure public.create_squadbet_user_records();

-- Backfill existing accounts.
insert into public.wallets (user_id)
select id from auth.users
on conflict (user_id) do nothing;


-- Challenge/match tables for installations that have not created them yet.
-- If these tables already exist, compare their columns and constraints before
-- applying this migration to production.
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  game text not null check (game in ('8-ball Pool','Whot','Ludo')),
  stake_amount numeric(12,2) not null check (stake_amount >= 500 and stake_amount <= 50000),
  status text not null default 'pending' check (status in ('pending','accepted','rejected','cancelled')),
  created_at timestamptz not null default now(),
  check (sender_id <> recipient_id)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'challenges_squadbet_stake_range') then
    alter table public.challenges add constraint challenges_squadbet_stake_range
      check (stake_amount >= 500 and stake_amount <= 50000 and stake_amount = trunc(stake_amount));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'challenges_squadbet_game') then
    alter table public.challenges add constraint challenges_squadbet_game
      check (game in ('8-ball Pool','Whot','Ludo'));
  end if;
end;
$$;

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null unique references public.challenges(id) on delete restrict,
  player1_id uuid not null references auth.users(id) on delete restrict,
  player2_id uuid not null references auth.users(id) on delete restrict,
  game text not null check (game in ('8-ball Pool','Whot','Ludo')),
  stake_amount numeric(12,2) not null,
  status text not null default 'lobby',
  player1_ready boolean not null default false,
  player2_ready boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists challenges_recipient_status_created_idx
  on public.challenges (recipient_id, status, created_at desc);
create index if not exists challenges_sender_created_idx
  on public.challenges (sender_id, created_at desc);
create unique index if not exists matches_challenge_id_unique_idx
  on public.matches (challenge_id);
create index if not exists matches_player1_created_idx
  on public.matches (player1_id, created_at desc);
create index if not exists matches_player2_created_idx
  on public.matches (player2_id, created_at desc);

alter table public.challenges enable row level security;
alter table public.matches enable row level security;

drop policy if exists "Players can read their own challenges" on public.challenges;
create policy "Players can read their own challenges" on public.challenges
  for select to authenticated using (auth.uid() = sender_id or auth.uid() = recipient_id);
drop policy if exists "Players can create challenges as themselves" on public.challenges;
create policy "Players can create challenges as themselves" on public.challenges
  for insert to authenticated with check (auth.uid() = sender_id and sender_id <> recipient_id);
drop policy if exists "Players can read their own matches" on public.matches;
create policy "Players can read their own matches" on public.matches
  for select to authenticated using (auth.uid() = player1_id or auth.uid() = player2_id);
revoke update, delete on public.challenges from anon, authenticated;
revoke insert, update, delete on public.matches from anon, authenticated;
grant select, insert on public.challenges to authenticated;
grant select on public.matches to authenticated;
grant all on public.challenges, public.matches to service_role;

-- Atomically reserve both players' stakes and create one shared lobby.
create or replace function public.accept_challenge_and_reserve_stakes(p_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_challenge public.challenges%rowtype;
  v_stake_kobo bigint;
  v_match_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found then raise exception 'Challenge not found'; end if;
  if v_challenge.recipient_id <> auth.uid() then raise exception 'Only the invited player can accept this challenge'; end if;
  if v_challenge.status <> 'pending' then raise exception 'Challenge is no longer pending'; end if;
  if v_challenge.sender_id = v_challenge.recipient_id then raise exception 'Players must be different'; end if;
  if v_challenge.game not in ('8-ball Pool','Whot','Ludo') then raise exception 'Unsupported game'; end if;
  if v_challenge.stake_amount < 500 or v_challenge.stake_amount > 50000 or v_challenge.stake_amount <> trunc(v_challenge.stake_amount) then
    raise exception 'Stake must be a whole naira amount between 500 and 50000';
  end if;
  v_stake_kobo := (v_challenge.stake_amount * 100)::bigint;

  insert into public.wallets (user_id) values (v_challenge.sender_id), (v_challenge.recipient_id)
    on conflict (user_id) do nothing;
  perform 1 from public.wallets
    where user_id in (v_challenge.sender_id, v_challenge.recipient_id)
    order by user_id for update;

  if (select available_balance_kobo from public.wallets where user_id = v_challenge.sender_id) < v_stake_kobo then
    raise exception 'Challenge sender has insufficient available balance';
  end if;
  if (select available_balance_kobo from public.wallets where user_id = v_challenge.recipient_id) < v_stake_kobo then
    raise exception 'Insufficient available balance to accept this challenge';
  end if;

  update public.wallets set available_balance_kobo = available_balance_kobo - v_stake_kobo,
    reserved_balance_kobo = reserved_balance_kobo + v_stake_kobo, updated_at = now()
    where user_id in (v_challenge.sender_id, v_challenge.recipient_id);

  update public.challenges set status = 'accepted' where id = v_challenge.id;
  insert into public.matches (challenge_id, player1_id, player2_id, game, stake_amount, status)
    values (v_challenge.id, v_challenge.sender_id, v_challenge.recipient_id, v_challenge.game, v_challenge.stake_amount, 'lobby')
    on conflict (challenge_id) do nothing returning id into v_match_id;
  if v_match_id is null then
    -- If an earlier transaction already created the lobby, do not reserve stakes twice.
    raise exception 'A match already exists for this challenge';
  end if;
  insert into public.wallet_ledger (user_id, reference, entry_type, amount_kobo, description)
  values
    (v_challenge.sender_id, 'stake-reserve:' || v_challenge.id::text || ':' || v_challenge.sender_id::text, 'stake_reserve', v_stake_kobo, 'Stake reserved for match ' || v_match_id::text),
    (v_challenge.recipient_id, 'stake-reserve:' || v_challenge.id::text || ':' || v_challenge.recipient_id::text, 'stake_reserve', v_stake_kobo, 'Stake reserved for match ' || v_match_id::text);
end;
$$;

create or replace function public.reject_challenge(p_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_challenge public.challenges%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found then raise exception 'Challenge not found'; end if;
  if v_challenge.recipient_id <> auth.uid() then raise exception 'Only the invited player can reject this challenge'; end if;
  if v_challenge.status <> 'pending' then raise exception 'Challenge is no longer pending'; end if;
  update public.challenges set status = 'rejected' where id = p_challenge_id;
end;
$$;
revoke all on function public.accept_challenge_and_reserve_stakes(uuid) from public, anon;
revoke all on function public.reject_challenge(uuid) from public, anon;
grant execute on function public.accept_challenge_and_reserve_stakes(uuid) to authenticated;
grant execute on function public.reject_challenge(uuid) to authenticated;

-- Enable realtime events for the dashboard/match lobby subscriptions when the
-- standard Supabase realtime publication exists.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'challenges') then
      alter publication supabase_realtime add table public.challenges;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'matches') then
      alter publication supabase_realtime add table public.matches;
    end if;
  end if;
end;
$$;
