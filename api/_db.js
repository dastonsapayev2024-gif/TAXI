'use strict';
const { Pool } = require('pg');
let pool = null, ready = null;

function P() {
  if (pool) return pool;
  const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!cs) throw new Error('DATABASE_URL sozlanmagan');
  pool = new Pool({ connectionString: cs, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000, ssl: { rejectUnauthorized: false } });
  return pool;
}

const DDL = `
begin;
select pg_advisory_xact_lock(7313001);
create table if not exists drivers(
  tg_id bigint primary key, name text not null default '', username text not null default '',
  balance bigint not null default 0, free_left int not null default 0, blocked boolean not null default false,
  state text not null default '', state_n bigint not null default 0, created timestamptz not null default now());
create table if not exists orders(
  id text primary key, uid bigint not null default 0, phone text not null, name text not null default '',
  fromp jsonb, top jsonb, km numeric, price int not null, fee int not null, status text not null default 'new',
  driver_id bigint, fee_paid int not null default 0, free_used boolean not null default false,
  created timestamptz not null default now(), taken_at timestamptz, done_at timestamptz);
create table if not exists topups(
  id serial primary key, driver_id bigint not null, amount bigint not null, status text not null default 'pending',
  file_id text not null default '', created timestamptz not null default now());
create table if not exists ledger(
  id serial primary key, driver_id bigint, delta bigint not null, kind text not null, ref text not null default '',
  created timestamptz not null default now());
create index if not exists orders_driver_idx on orders(driver_id, created desc);

-- ===== Tugmali taksi boti (liniya + oylik obuna) =====
create table if not exists ln_regions(id serial primary key, parent_id int references ln_regions(id) on delete cascade, name text not null, kind text not null, created timestamptz not null default now());
create unique index if not exists ln_reg_u on ln_regions((coalesce(parent_id,0)), lower(name));
create table if not exists ln_drivers(
  tg_id bigint primary key, name text not null default '', username text not null default '', phone text not null default '', car text not null default '',
  kind text not null default '', region_id int, paid_until timestamptz, online boolean not null default false, online_at timestamptz,
  blocked boolean not null default false, created timestamptz not null default now());
create table if not exists ln_users(tg_id bigint primary key, name text not null default '', phone text not null default '');
create table if not exists ln_orders(
  id text primary key, uid bigint not null, pname text not null default '', phone text not null default '', kind text not null, region_id int,
  to_text text not null default '', addr text not null default '', lat double precision, lng double precision, status text not null default 'new',
  driver_id bigint, created timestamptz not null default now(), taken_at timestamptz, done_at timestamptz);
create table if not exists ln_msgs(order_id text not null, chat_id bigint not null, msg_id bigint not null);
create index if not exists ln_msgs_o on ln_msgs(order_id);
create table if not exists ln_pay(id serial primary key, driver_id bigint not null, amount bigint not null default 0, status text not null default 'pending', file_id text not null default '', created timestamptz not null default now(), decided timestamptz);
create table if not exists ln_state(tg_id bigint primary key, st text not null default '', data jsonb not null default '{}', updated timestamptz not null default now());
alter table ln_regions add column if not exists active boolean not null default true;
alter table ln_users add column if not exists created timestamptz not null default now();
alter table ln_users add column if not exists blocked boolean not null default false;
do $seed$ declare x int; q int; begin
  if not exists (select 1 from ln_regions) then
    insert into ln_regions(parent_id,name,kind) values (null,'Xorazm','viloyat') returning id into x;
    insert into ln_regions(parent_id,name,kind) values (x,'Qo‘shko‘pir','tuman') returning id into q;
    insert into ln_regions(parent_id,name,kind) values (q,'O‘rta Qishloq (Nezaxos)','mahalla');
    insert into ln_regions(parent_id,name,kind) values (x,'Xiva','tuman');
    insert into ln_regions(parent_id,name,kind) values (x,'Urganch','tuman');
  end if;
end $seed$;
alter table ln_drivers add column if not exists to_id int;
alter table ln_orders add column if not exists to_id int;
alter table ln_orders add column if not exists people int;
alter table ln_orders add column if not exists uname text;
alter table ln_orders add column if not exists remind_at timestamptz;
alter table ln_orders add column if not exists acc real;
alter table ln_orders add column if not exists rating smallint;
update ln_regions set name='O‘rta Qishloq (Nezaxos)' where name='O‘rta Qishloq' and kind='mahalla';
insert into ln_regions(parent_id,name,kind,active) select null, v, 'viloyat', false from unnest(array['Toshkent shahri','Toshkent viloyati','Samarqand','Buxoro','Navoiy','Qashqadaryo','Surxondaryo','Jizzax','Sirdaryo','Farg‘ona','Andijon','Namangan','Qoraqalpog‘iston']) as v on conflict do nothing;

do $pop$ declare r record; begin
  for r in select * from (values
  ('Xorazm', array['Shovot','Xonqa','Hazorasp','Yangiariq','Yangibozor','Bog‘ot','Gurlan']),
  ('Toshkent shahri', array['Chilonzor','Yunusobod','Mirzo Ulug‘bek','Sergeli','Yakkasaroy','Shayxontohur','Olmazor','Mirobod','Yashnobod','Uchtepa']),
  ('Toshkent viloyati', array['Chirchiq','Olmaliq','Angren','Bekobod','Yangiyo‘l','Nurafshon','Zangiota','Qibray','Ohangaron','Parkent']),
  ('Samarqand', array['Samarqand shahri','Urgut','Kattaqo‘rg‘on','Bulung‘ur','Jomboy','Ishtixon','Pastdarg‘om','Narpay','Payariq','Oqdaryo']),
  ('Buxoro', array['Buxoro shahri','G‘ijduvon','Kogon','Qorako‘l','Vobkent','Shofirkon','Romitan','Jondor']),
  ('Navoiy', array['Navoiy shahri','Zarafshon','Uchquduq','Karmana','Nurota','Xatirchi','Qiziltepa']),
  ('Qashqadaryo', array['Qarshi','Shahrisabz','Kitob','Koson','G‘uzor','Muborak','Yakkabog‘','Chiroqchi','Dehqonobod']),
  ('Surxondaryo', array['Termiz','Denov','Sho‘rchi','Sherobod','Boysun','Qumqo‘rg‘on','Jarqo‘rg‘on','Angor']),
  ('Jizzax', array['Jizzax shahri','Zomin','G‘allaorol','Do‘stlik','Forish','Paxtakor','Baxmal']),
  ('Sirdaryo', array['Guliston','Yangiyer','Shirin','Sirdaryo tumani','Boyovut','Sardoba']),
  ('Farg‘ona', array['Farg‘ona shahri','Qo‘qon','Marg‘ilon','Quvasoy','Beshariq','Rishton','Oltiariq','Quva','Uchko‘prik','Bog‘dod']),
  ('Andijon', array['Andijon shahri','Asaka','Shahrixon','Xonobod','Marhamat','Paxtaobod','Qo‘rg‘ontepa','Oltinko‘l','Bo‘z','Xo‘jaobod']),
  ('Namangan', array['Namangan shahri','Chust','Pop','Kosonsoy','Uchqo‘rg‘on','To‘raqo‘rg‘on','Chortoq','Uychi','Mingbuloq']),
  ('Qoraqalpog‘iston', array['Nukus','Xo‘jayli','Qo‘ng‘irot','To‘rtko‘l','Beruniy','Chimboy','Mo‘ynoq','Qanliko‘l','Taxiatosh','Amudaryo'])
  ) as t(v, arr) loop
    insert into ln_regions(parent_id,name,kind,active)
      select v.id, u.n, 'tuman', false from ln_regions v, unnest(r.arr) with ordinality as u(n,o)
      where v.kind='viloyat' and v.parent_id is null and lower(v.name)=lower(r.v) order by u.o
      on conflict do nothing;
  end loop;
end $pop$;
alter table drivers add column if not exists car text not null default '';
alter table drivers add column if not exists phone text not null default '';
create table if not exists settings(key text primary key, val text not null, updated timestamptz not null default now());
alter table drivers add column if not exists verified boolean not null default false;
alter table drivers add column if not exists online boolean not null default false;
alter table drivers add column if not exists seen timestamptz;
create table if not exists passengers(
  tg_id bigint primary key, name text not null default '', phone text not null default '', created timestamptz not null default now());
alter table orders add column if not exists token text not null default '';
alter table orders add column if not exists tg_msg bigint;
alter table orders add column if not exists dlat double precision;
alter table orders add column if not exists dlng double precision;
alter table orders add column if not exists dts timestamptz;
drop function if exists accept_order(text, bigint);

create or replace function accept_order(p_oid text, p_did bigint, p_exp int) returns json language plpgsql as $fn$
declare o orders; d drivers; f int; fr boolean;
begin
  select * into o from orders where id = p_oid for update;
  if not found then return json_build_object('err','noorder'); end if;
  if o.status = 'new' and o.created < now() - make_interval(mins => p_exp) then
    update orders set status='expired' where id = p_oid;
    return json_build_object('err','expired','msg',o.tg_msg);
  end if;
  if o.status in ('cancelled','expired') then return json_build_object('err','gone'); end if;
  if o.status <> 'new' then return json_build_object('err','taken'); end if;
  select * into d from drivers where tg_id = p_did for update;
  if not found or d.blocked then return json_build_object('err','nodriver'); end if;
  if d.car = '' then return json_build_object('err','nocar'); end if;
  fr := d.free_left > 0;
  f := case when fr then 0 else o.fee end;
  if d.balance < f then return json_build_object('err','balance','need',f,'bal',d.balance); end if;
  update drivers set balance = balance - f, free_left = free_left - (case when fr then 1 else 0 end) where tg_id = p_did;
  update orders set status='taken', driver_id=p_did, fee_paid=f, free_used=fr, taken_at=now() where id = p_oid;
  if f > 0 then insert into ledger(driver_id, delta, kind, ref) values (p_did, -f, 'fee', p_oid); end if;
  return json_build_object('ok',true,'phone',o.phone,'uid',o.uid,'fee',f,'free',fr,'bal',d.balance - f,'left',d.free_left - (case when fr then 1 else 0 end),'car',d.car,'uname',d.username);
end $fn$;

create or replace function cancel_by_passenger(p_oid text, p_token text) returns json language plpgsql as $fn$
declare o orders;
begin
  select * into o from orders where id = p_oid for update;
  if not found or o.token = '' or o.token <> p_token then return json_build_object('err','noorder'); end if;
  if o.status = 'done' then return json_build_object('err','done'); end if;
  if o.status in ('cancelled','expired','failed') then return json_build_object('err','already'); end if;
  if o.status = 'taken' then
    update drivers set balance = balance + o.fee_paid, free_left = free_left + (case when o.free_used then 1 else 0 end) where tg_id = o.driver_id;
    if o.fee_paid > 0 then insert into ledger(driver_id, delta, kind, ref) values (o.driver_id, o.fee_paid, 'refund', p_oid); end if;
  end if;
  update orders set status='cancelled' where id = p_oid;
  return json_build_object('ok',true,'was',o.status,'driver',o.driver_id,'msg',o.tg_msg,'refund',o.fee_paid);
end $fn$;

create or replace function expire_if_old(p_oid text, p_exp int) returns json language plpgsql as $fn$
declare o orders;
begin
  select * into o from orders where id = p_oid for update;
  if not found then return json_build_object('changed',false); end if;
  if o.status = 'new' and o.created < now() - make_interval(mins => p_exp) then
    update orders set status='expired' where id = p_oid;
    return json_build_object('changed',true,'msg',o.tg_msg);
  end if;
  return json_build_object('changed',false);
end $fn$;

create or replace function cancel_order(p_oid text, p_did bigint, p_min int) returns json language plpgsql as $fn$
declare o orders;
begin
  select * into o from orders where id = p_oid for update;
  if not found then return json_build_object('err','noorder'); end if;
  if o.status <> 'taken' or o.driver_id is distinct from p_did then return json_build_object('err','notyours'); end if;
  if o.taken_at < now() - make_interval(mins => p_min) then return json_build_object('err','late'); end if;
  update drivers set balance = balance + o.fee_paid, free_left = free_left + (case when o.free_used then 1 else 0 end) where tg_id = p_did;
  if o.fee_paid > 0 then insert into ledger(driver_id, delta, kind, ref) values (p_did, o.fee_paid, 'refund', p_oid); end if;
  update orders set status='new', driver_id=null, fee_paid=0, free_used=false, taken_at=null, dlat=null, dlng=null, dts=null where id = p_oid;
  return json_build_object('ok',true,'refund',o.fee_paid);
end $fn$;

create or replace function done_order(p_oid text, p_did bigint) returns json language plpgsql as $fn$
declare n int;
begin
  update orders set status='done', done_at=now() where id = p_oid and status='taken' and driver_id = p_did;
  get diagnostics n = row_count;
  if n = 0 then return json_build_object('err','notyours'); end if;
  return json_build_object('ok',true);
end $fn$;

create or replace function topup_decide(p_id int, p_ok boolean) returns json language plpgsql as $fn$
declare t topups; b bigint;
begin
  select * into t from topups where id = p_id for update;
  if not found then return json_build_object('err','notopup'); end if;
  if t.status <> 'pending' then return json_build_object('err','done','status',t.status); end if;
  if p_ok then
    update drivers set balance = balance + t.amount where tg_id = t.driver_id returning balance into b;
    if b is null then return json_build_object('err','nodriver'); end if;
    insert into ledger(driver_id, delta, kind, ref) values (t.driver_id, t.amount, 'topup', t.id::text);
    update topups set status='ok' where id = p_id;
    return json_build_object('ok',true,'driver',t.driver_id,'amount',t.amount,'bal',b);
  end if;
  update topups set status='no' where id = p_id;
  return json_build_object('ok',true,'rejected',true,'driver',t.driver_id,'amount',t.amount);
end $fn$;

create or replace function admin_add(p_did bigint, p_amt bigint) returns json language plpgsql as $fn$
declare b bigint;
begin
  update drivers set balance = balance + p_amt where tg_id = p_did returning balance into b;
  if b is null then return json_build_object('err','nodriver'); end if;
  insert into ledger(driver_id, delta, kind, ref) values (p_did, p_amt, 'admin', '');
  return json_build_object('ok',true,'bal',b);
end $fn$;
commit;
`;

async function ensure() {
  if (!ready) ready = P().query(DDL).catch(e => { ready = null; throw e; });
  return ready;
}
async function q(sql, params) { await ensure(); return P().query(sql, params || []); }
async function fn(name, ...args) {
  const r = await q('select ' + name + '(' + args.map((_, i) => '$' + (i + 1)).join(',') + ') as r', args);
  return r.rows[0].r;
}
module.exports = { q, fn, ensure };
