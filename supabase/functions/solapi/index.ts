// 만남살롱 메리지 로테이션 — 솔라피 발송 (Supabase Edge Function 이름: solapi)
// 어드민에 로그인한 운영자만 호출할 수 있어요. 솔라피 키는 여기(서버 비밀값)에만 있고 HTML에는 없어요.
//
// Supabase → Edge Functions → Secrets 에 넣을 값
//   SOLAPI_API_KEY     솔라피 API Key
//   SOLAPI_API_SECRET  솔라피 API Secret
//   SOLAPI_FROM        솔라피에 등록한 발신번호 (예: 0212345678)
//   SOLAPI_PFID        카카오 채널 연결 후 받은 pfId (KA01PF...)
//   ADMIN_EMAILS       (선택) 발송 허용할 어드민 이메일, 쉼표로 구분
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const env = (k: string) => Deno.env.get(k) || '';
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

async function authHeader() {
  const date = new Date().toISOString();
  const salt = crypto.randomUUID().replace(/-/g, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env('SOLAPI_API_SECRET')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(date + salt));
  const hex = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `HMAC-SHA256 apiKey=${env('SOLAPI_API_KEY')}, date=${date}, salt=${salt}, signature=${hex}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST만 받아요' }, 405);

  // 1) 로그인한 어드민 계정인지 확인
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('Authorization') || '' } } });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return json({ error: '어드민에 로그인해야 보낼 수 있어요' }, 401);
  const allow = env('ADMIN_EMAILS').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes((user.email || '').toLowerCase())) return json({ error: '발송 권한이 없는 계정이에요' }, 403);
  if (!env('SOLAPI_API_KEY') || !env('SOLAPI_API_SECRET') || !env('SOLAPI_FROM')) return json({ error: '솔라피 키 · 발신번호(Secrets)가 아직 없어요' }, 500);

  const body = await req.json().catch(() => ({}));

  // 2) 연결 확인: 솔라피 잔액 조회
  if (body.action === 'ping') {
    const r = await fetch('https://api.solapi.com/cash/v1/balance', { headers: { Authorization: await authHeader() } });
    return json({ ok: r.ok, status: r.status, result: await r.json().catch(() => ({})), pfId: !!env('SOLAPI_PFID') }, r.ok ? 200 : 502);
  }

  // 3) 발송: messages = [{ type:'ata', to, templateId, variables }, { type:'sms', to, text }]
  const messages: Record<string, unknown>[] = [];
  for (const m of (Array.isArray(body.messages) ? body.messages : []).slice(0, 300)) {
    const to = String(m.to || '').replace(/\D/g, '');
    if (!/^01\d{8,9}$/.test(to)) continue;
    if (m.type === 'ata') {
      if (!env('SOLAPI_PFID') || !m.templateId) continue;
      messages.push({ to, from: env('SOLAPI_FROM'), kakaoOptions: { pfId: env('SOLAPI_PFID'), templateId: String(m.templateId), variables: m.variables || {}, disableSms: false } });
    } else if (m.text) {
      messages.push({ to, from: env('SOLAPI_FROM'), text: String(m.text).slice(0, 2000) });
    }
  }
  if (!messages.length) return json({ error: '보낼 수 있는 메시지가 없어요 (번호 · 템플릿 ID · pfId 확인)' }, 400);

  const r = await fetch('https://api.solapi.com/messages/v4/send-many/detail', {
    method: 'POST',
    headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  const out = await r.json().catch(() => ({}));
  const failed = (out.failedMessageList || []).map((f: any) => ({ to: f.to, code: f.statusCode, msg: f.statusMessage }));
  return json({ ok: r.ok && failed.length < messages.length, sent: messages.length - failed.length, failed, status: r.status, error: r.ok ? undefined : (out.errorMessage || out.message || '솔라피 오류') }, r.ok ? 200 : 502);
});
