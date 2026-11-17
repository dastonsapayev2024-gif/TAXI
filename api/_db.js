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

alter table drivers add column if not exists car text not null default '';
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
