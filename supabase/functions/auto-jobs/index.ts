// 만남살롱 주문 자동화 (Supabase Edge Function 이름: auto-jobs) — 1분마다 pg_cron 이 불러요
//
//  ① 프립 자동승인: 설정한 시간대(예: 10:00~22:00)에만, 프립 '대기중' 주문을 프립 호스트에서 예약확정
//     · 진행일정 상태에 x(블랙 포함)가 있는 사람 · 블랙리스트 · 메모에 '취소' · 그 날짜 데이터미포함 인원은 제외
//     · 대상 성별(여자만/전체) 선택 · 리허설 모드(확정 직전까지만) 지원
//     · 실제 확정은 기존 frip-sync 함수의 confirm 을 그대로 씀 · 한 주문은 한 번만 시도 (실패하면 어드민에 ⚠ 표시)
//  ② 자사몰 자동 배송중: 아임웹 주문을 결제 시각 + N분(기본 30분)이 지나면 그 주문 한 건씩 배송대기 → 배송중으로
//     · 기능을 켠 시각 이후 결제된 주문만 · 이미 배송중/취소된 품목은 건드리지 않음
//
// 설정은 auto_settings 표(어드민 주문관리 '자동화' 줄에서 바꿈), 처리 기록은 auto_log 표에 남아요.
// 필요한 Secrets: IMWEB_KEY, IMWEB_SECRET (frip-sync 와 같은 값 · 이미 들어가 있음)
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const env = (k: string) => Deno.env.get(k) || '';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const p2 = (n: number) => String(n).padStart(2, '0');

// 한국 시간
const kstNow = () => { const d = new Date(Date.now() + 9 * 3600e3); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() }; };
const kstMs = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - 9 * 3600e3;
const hm = (s: string) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };
function inWindow(from: string, to: string) {
  const a = hm(from), b = hm(to); if (a == null || b == null) return false;
  const n = kstNow(), t = n.h * 60 + n.mi;
  if (a === b) return true;                       // 같은 시각 = 24시간
  return a < b ? (t >= a && t < b) : (t >= a || t < b);   // 22:00~02:00 처럼 자정을 넘기는 경우
}

async function getSettings() {
  const { data, error } = await sb.from('auto_settings').select('key,value');
  if (error) throw new Error('auto_settings 표를 읽지 못했어요: ' + error.message);
  const s: Record<string, any> = {}; (data || []).forEach((r: any) => { s[r.key] = r.value || {}; });
  return s;
}
async function getLog(kind: string, oids: string[]) {
  const m = new Map<string, any>(); if (!oids.length) return m;
  for (let i = 0; i < oids.length; i += 200) {
    const { data } = await sb.from('auto_log').select('*').eq('kind', kind).in('oid', oids.slice(i, i + 200));
    (data || []).forEach((r: any) => m.set(r.oid, r));
  }
  return m;
}
const writeLog = (row: any) => sb.from('auto_log').upsert({ ...row, id: row.kind + ':' + row.oid, at: new Date().toISOString() }, { onConflict: 'id' });

/* ---------------- ① 프립 자동승인 ---------------- */
// 어드민과 같은 규칙: 옵션·상품명의 "10/24(토)_남성(19:30분)" 에서 날짜·시간을 읽음 (연도는 주문시간 기준)
function eventAt(o: any) {
  const t = String(o.event || '') + ' ' + String(o.product || '');
  const m = t.match(/(\d{1,2})\s*[./월]\s*(\d{1,2})(?!\d)/); if (!m) return null;
  const mo = +m[1], d = +m[2]; if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const ot = String(o.time || ''); const n = kstNow();
  const oy = ot.length >= 6 ? 2000 + +ot.slice(0, 2) : n.y, om = ot.length >= 6 ? +ot.slice(2, 4) : n.mo;
  let y = oy; if (mo < om - 6) y++;              // 12월 주문 → 1월 행사
  const tm = t.match(/(\d{1,2})\s*:\s*(\d{2})|(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/); if (!tm) return null;
  const h = +(tm[1] || tm[3]), mi = +(tm[2] || tm[4] || 0); if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return { ms: kstMs(y, mo, d, h, mi), date: `${y}-${p2(mo)}-${p2(d)}`, time: `${p2(h)}:${p2(mi)}` };
}
async function callFripConfirm(body: any) {
  const url = env('SUPABASE_URL') + '/functions/v1/frip-sync';
  const keys = [env('SUPABASE_ANON_KEY'), env('SUPABASE_SERVICE_ROLE_KEY')].filter(k => k.startsWith('eyJ'));
  let last = '';
  for (const k of keys.length ? keys : [env('SUPABASE_ANON_KEY')]) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + k, apikey: k }, body: JSON.stringify({ job: 'confirm', ...body }) });
    let j: any = {}; try { j = await res.json(); } catch (_) {}
    if (res.status === 401) { last = 'frip-sync 호출 권한 오류(401)'; continue; }
    if (!res.ok || j.ok === false) throw new Error(j.error || j.message || ('HTTP ' + res.status));
    return j;
  }
  throw new Error(last || 'frip-sync 를 부르지 못했어요');
}
async function fripAuto(cfg: any, out: any) {
  const mode = cfg.mode === 'dry' ? 'dry' : cfg.mode === 'on' ? 'on' : 'off';
  if (mode === 'off') return (out.frip = '꺼짐');
  if (!inWindow(cfg.from, cfg.to)) return (out.frip = `시간대 밖 (${cfg.from}~${cfg.to})`);
  const { data, error } = await sb.from('orders').select('id,time,gender,nick,name,phone,stat,black,event,product,memo').like('id', 'FRIP-%').eq('stat', '대기중');
  if (error) throw new Error('orders: ' + error.message);
  const xPh = new Set((cfg.xPhones || []).map(digits));
  const exclK = new Set((cfg.exclKeys || []).map(String));
  const now = Date.now(), list: any[] = [], skip: Record<string, number> = {};
  const sk = (k: string) => { skip[k] = (skip[k] || 0) + 1; };
  for (const o of data || []) {
    const ph = digits(o.phone);
    if (o.black === 'YES' || xPh.has(ph)) { sk('상태x·블랙'); continue; }
    if (cfg.women !== false && o.gender !== '여') { sk('성별'); continue; }
    if (/취소/.test(String(o.memo || ''))) { sk('메모 취소'); continue; }
    const at = eventAt(o); if (!at) { sk('일시 못 읽음'); continue; }
    if (at.ms < now) { sk('지난 일정'); continue; }
    if (exclK.has(ph + '|' + at.date)) { sk('데이터미포함'); continue; }
    list.push({ o, at });
  }
  const logs = await getLog('frip', list.map(x => x.o.id));
  const todo = list.filter(x => { const l = logs.get(x.o.id); return !l || (l.dry && mode === 'on'); }).sort((a, b) => String(a.o.time).localeCompare(String(b.o.time)));
  const done: string[] = [];
  for (const { o, at } of todo.slice(0, 4)) {
    const label = `${o.name || o.nick || ''} ${+at.date.slice(5, 7)}/${+at.date.slice(8)} ${at.time}`;
    // 먼저 기록해 두어 다음 실행과 겹치지 않게 함 (새 주문은 insert — 다른 실행이 먼저 잡았으면 건너뜀)
    if (!logs.get(o.id)) {
      const { error: ce } = await sb.from('auto_log').insert({ id: 'frip:' + o.id, kind: 'frip', oid: o.id, ok: null, dry: mode === 'dry', tries: 1, msg: label + ' · 진행 중' });
      if (ce) continue;
    } else await writeLog({ kind: 'frip', oid: o.id, ok: null, dry: mode === 'dry', tries: 1, msg: label + ' · 진행 중' });
    try {
      const r = await callFripConfirm({ orderId: o.id, phone: o.phone, date: at.date, time: at.time, dry: mode === 'dry' });
      if (mode === 'on') await sb.from('orders').update({ stat: '확정' }).eq('id', o.id);
      await writeLog({ kind: 'frip', oid: o.id, ok: true, dry: mode === 'dry', tries: 1, msg: (r.message || label) + (mode === 'dry' ? ' (리허설)' : '') });
      done.push(label);
    } catch (e) {
      await writeLog({ kind: 'frip', oid: o.id, ok: false, dry: mode === 'dry', tries: 1, msg: label + ' · ' + ((e as Error).message || e) });
    }
  }
  out.frip = { mode, candidates: list.length, processed: done, waiting: Math.max(0, todo.length - 4), skipped: skip };
}

/* ---------------- ② 자사몰 자동 배송중 (아임웹 v2 API) ---------------- */
const IMWEB_API = 'https://api.imweb.me/v2';
let imTok = '';
async function imToken() {
  if (imTok) return imTok;
  const key = env('IMWEB_KEY'), secret = env('IMWEB_SECRET'); if (!key || !secret) throw new Error('시크릿 IMWEB_KEY / IMWEB_SECRET 이 없어요');
  const tries = [
    () => fetch(IMWEB_API + '/auth?key=' + encodeURIComponent(key) + '&secret=' + encodeURIComponent(secret)),
    () => fetch(IMWEB_API + '/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, secret }) }),
  ];
  let last = '';
  for (const t of tries) { const r = await t(); let j: any = {}; try { j = await r.json(); } catch (_) {} if (j.access_token) return (imTok = j.access_token); last = j.msg || ('HTTP ' + r.status); }
  throw new Error('아임웹 토큰 발급 실패 - ' + last);
}
async function im(method: string, path: string, body?: any) {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(IMWEB_API + path, { method, headers: { 'access-token': await imToken(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let j: any = {}; try { j = await r.json(); } catch (_) {}
    if (r.status === 429 || j.code === -7) { await new Promise(s => setTimeout(s, 1200)); continue; }   // 요청 과다 → 잠깐 쉬고 다시
    if (j.code === -1 || j.code === -2 || /token/i.test(String(j.msg || ''))) { imTok = ''; if (a < 2) continue; }
    return j;
  }
  return { code: -7, msg: '아임웹 요청이 너무 많아요' };
}
const DONE_ST = /DELIVERING|COMPLETE|PURCHASE|CANCEL|RETURN|EXCHANGE|배송중|배송완료|구매확정|취소|반품|교환/i;
const WAIT_ST = /PAY_WAIT|입금대기|결제대기/i;
const STANDBY_ST = /STANDBY|배송대기/i;
function payMs(o: any) {   // 결제 시각(초) — 없으면 주문 시각
  const p = o && (o.payment || {});
  const v = +(p.payment_time || p.pay_time || p.paid_time || p.complete_time || 0) || +(o && (o.order_time || o.order_date) || 0);
  return v ? (v < 1e12 ? v * 1000 : v) : 0;
}
function prodList(j: any) {
  const d = j && j.data; if (!d) return [];
  const arr = Array.isArray(d) ? d : Array.isArray(d.list) ? d.list : Object.values(d);
  return (arr as any[]).filter(x => x && (x.order_no || x.prod_order_no || x.no));
}
async function imwebShip(cfg: any, out: any) {
  if (!cfg.on) return (out.imweb = '꺼짐');
  const delay = Math.max(1, +cfg.delayMin || 30) * 60e3, since = Date.parse(cfg.onAt || '') || Date.now();
  const n = new Date(Date.now() + 9 * 3600e3 - 4 * 864e5);   // 최근 4일 주문만 살펴봄
  const from = `${String(n.getUTCFullYear()).slice(2)}${p2(n.getUTCMonth() + 1)}${p2(n.getUTCDate())}`;
  const { data, error } = await sb.from('orders').select('id,time,stat,name,nick').like('id', 'IMWEB-%').gte('time', from);
  if (error) throw new Error('orders: ' + error.message);
  const byNo = new Map<string, any[]>();
  (data || []).forEach((o: any) => { const m = String(o.id).match(/^IMWEB-(\d+)/); if (!m || o.stat === '취소') return; (byNo.get(m[1]) || byNo.set(m[1], []).get(m[1])!).push(o); });
  const logs = await getLog('imweb', [...byNo.keys()]);
  const res: string[] = [], errs: string[] = []; let checked = 0;
  for (const [no, os] of byNo) {
    const l = logs.get(no); if (l && (l.ok || (l.tries || 0) >= 3 || l.skip)) continue;
    // 주문 시각(어드민 값, 한국시간 YYMMDDHHmm)으로 먼저 거름: 기능 켜기 전·30분 안 된 주문은 아임웹에 묻지 않음
    const t = String(os[0].time || ''); const om = t.length >= 10 ? kstMs(2000 + +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6), +t.slice(6, 8), +t.slice(8, 10)) : 0;
    if (om && om + delay > Date.now()) continue;
    if (om && om < since - 5 * 60e3) continue;
    if (checked++ >= 8) break;                   // 한 번에 8건까지만 (나머지는 1분 뒤)
    const who = os[0].name || os[0].nick || no;
    try {
      const od = await im('GET', `/shop/orders/${no}`);
      const ord = od && od.data; const pm = payMs(ord);
      if (pm && pm + delay > Date.now()) continue;                          // 결제 후 아직 N분 안 됨
      if (pm && pm < since) { await writeLog({ kind: 'imweb', oid: no, ok: false, skip: true, tries: 0, msg: `${who} · 기능 켜기 전 결제라 건너뜀` }); continue; }
      let prods: any[] = []; let ver = '';
      for (const v of ['v2', 'v1']) { const j = await im('GET', `/shop/orders/${no}/prod-orders?order_version=${v}`); prods = prodList(j); if (prods.length) { ver = v; break; } }
      if (!prods.length) throw new Error('품목 주문을 찾지 못했어요');
      if (prods.every(p => DONE_ST.test(String(p.status || p.state || '')))) { await writeLog({ kind: 'imweb', oid: no, ok: true, tries: 0, msg: `${who} · 이미 배송중/처리됨` }); continue; }
      if (prods.some(p => WAIT_ST.test(String(p.status || '')))) continue;   // 아직 입금 전
      const fails: string[] = [];
      for (const p of prods) {
        const st = String(p.status || p.state || ''), pno = p.prod_order_no || p.order_no || p.no;
        if (DONE_ST.test(st)) continue;
        if (!STANDBY_ST.test(st)) {
          const a = await im('PATCH', `/shop/prod-orders/${pno}/place`, { order_version: ver });
          const f = a && a.data && Array.isArray(a.data.failed) ? a.data.failed : [];
          if ((a.code && a.code !== 200) || f.length) { const fm = f[0] ? (f[0].detail_msg || f[0].msg) : a.msg; if (!/배송대기|이미|STANDBY/.test(String(fm))) { fails.push('배송대기 처리 실패: ' + fm); continue; } }
        }
        const b = await im('PATCH', `/shop/prod-orders/${pno}/send`, { order_version: ver });
        const f2 = b && b.data && Array.isArray(b.data.failed) ? b.data.failed : [];
        if ((b.code && b.code !== 200) || f2.length) fails.push('배송중 처리 실패: ' + (f2[0] ? (f2[0].detail_msg || f2[0].msg) : b.msg));
      }
      const tries = ((l && l.tries) || 0) + 1;
      if (fails.length) { errs.push(`${who}: ${fails[0]}`); await writeLog({ kind: 'imweb', oid: no, ok: false, tries, msg: `${who} · ${fails[0]}` + (tries >= 3 ? ' (3번 실패 · 직접 처리해 주세요)' : '') }); }
      else { res.push(who); await writeLog({ kind: 'imweb', oid: no, ok: true, tries, msg: `${who} · 배송중으로 변경` }); }
    } catch (e) {
      const tries = ((l && l.tries) || 0) + 1; const m = (e as Error).message || String(e);
      errs.push(`${who}: ${m}`); await writeLog({ kind: 'imweb', oid: no, ok: false, tries, msg: `${who} · ${m}` });
    }
  }
  out.imweb = { shipped: res, errors: errs };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const out: any = { ok: true, at: new Date().toISOString() };
  try {
    const s = await getSettings();
    try { await fripAuto(s.frip_auto || {}, out); } catch (e) { out.frip = { error: (e as Error).message }; }
    try { await imwebShip(s.imweb_ship || {}, out); } catch (e) { out.imweb = { error: (e as Error).message }; }
    await sb.from('auto_settings').upsert({ key: 'last_run', value: out, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch (e) { return json({ ok: false, error: (e as Error).message }, 500); }
  return json(out);
});
