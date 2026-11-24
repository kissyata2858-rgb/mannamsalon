-- 만남살롱 주문 자동화 (프립 자동승인 · 자사몰 자동 배송중) — Supabase SQL Editor 에서 한 번 실행
-- 1) 설정·기록 표
create table if not exists public.auto_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.auto_log (
  id text primary key,            -- kind:oid
  kind text not null,             -- frip | imweb
  oid text not null,              -- 프립 주문 id / 아임웹 주문번호
  ok boolean,
  dry boolean default false,
  skip boolean default false,
  tries int default 0,
  msg text default '',
  at timestamptz not null default now()
);
create index if not exists auto_log_at on public.auto_log (at desc);

alter table public.auto_settings enable row level security;
alter table public.auto_log enable row level security;
drop policy if exists "admin all" on public.auto_settings;
create policy "admin all" on public.auto_settings for all to authenticated using (true) with check (true);
drop policy if exists "admin all" on public.auto_log;
create policy "admin all" on public.auto_log for all to authenticated using (true) with check (true);

-- 처음엔 둘 다 꺼진 상태로 시작 (어드민 주문관리 '자동화' 줄에서 켜요)
insert into public.auto_settings (key, value) values
  ('frip_auto',  '{"mode":"off","from":"10:00","to":"22:00","women":true,"xPhones":[],"exclKeys":[]}'),
  ('imweb_ship', '{"on":false,"delayMin":30}')
on conflict (key) do nothing;

do $$ begin
  begin alter publication supabase_realtime add table public.auto_settings; exception when others then null; end;
  begin alter publication supabase_realtime add table public.auto_log; exception when others then null; end;
end $$;

-- 2) 1분마다 auto-jobs 함수 실행 (frip-sync 자동 실행에 넣었던 것과 같은 eyJ… anon 키를 넣으세요)
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('auto-jobs') where exists (select 1 from cron.job where jobname = 'auto-jobs');
select cron.schedule(
  'auto-jobs',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://jhgtzkckrejluxfpausw.supabase.co/functions/v1/auto-jobs',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer 여기에_ANON_KEY'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 140000
  );
  $$
);
