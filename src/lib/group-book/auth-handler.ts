import {createManagedClassroomAuth, CLASSROOM_AUTH_COOKIE} from './managed-auth.ts';

export interface ClassroomAuthConfig { enabled: boolean; publishableKey: string; secure: boolean }
const headers = {'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive'};
const reply = (body: object, status=200) => Response.json(body,{status,headers});

// Preview-only recipient guard: exact, normalized (trim/lowercase) match against a bounded,
// expiring server-only allowlist. No aliases, wildcards, domains, suffixes or patterns.
const PREVIEW_RECIPIENT=/^[a-z0-9][a-z0-9._+-]*@[a-z0-9-]+(?:[.][a-z0-9-]+)+$/;
const ISO_UTC=/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]{3}))?Z$/;
const normalizeRecipient=(value: string)=>value.trim().toLowerCase();
function isoUtcMs(value: unknown): number | null {
  if (typeof value!=='string') return null;
  const m=ISO_UTC.exec(value);
  if (!m) return null;
  const [y,mo,d,h,mi,s]=m.slice(1,7).map(Number);
  const ms=Number(m[7] ?? '0');
  const t=Date.UTC(y,mo-1,d,h,mi,s,ms);
  const dt=new Date(t);
  if (!Number.isFinite(t) || dt.getUTCFullYear()!==y || dt.getUTCMonth()!==mo-1 || dt.getUTCDate()!==d ||
      dt.getUTCHours()!==h || dt.getUTCMinutes()!==mi || dt.getUTCSeconds()!==s || dt.getUTCMilliseconds()!==ms) return null;
  return t;
}
function previewRecipientAllowed(email: string, configured: string | undefined): boolean {
  if (typeof configured!=='string' || !configured || configured.length>1024) return false;
  let parsed: unknown;
  try { parsed=JSON.parse(configured); } catch { return false; }
  if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) return false;
  const keys=Object.keys(parsed).sort();
  if (keys.length!==2 || keys[0]!=='emails' || keys[1]!=='expiresAt') return false;
  const {emails, expiresAt}=parsed as Record<string,unknown>;
  const expiry=isoUtcMs(expiresAt);
  if (expiry===null || !(expiry>Date.now())) return false;
  if (!Array.isArray(emails) || emails.length<1 || emails.length>2) return false;
  const approved: string[]=[];
  for (const entry of emails) {
    if (typeof entry!=='string' || entry.length>254) return false;
    const normalized=normalizeRecipient(entry);
    if (normalized.length>254 || !PREVIEW_RECIPIENT.test(normalized)) return false;
    approved.push(normalized);
  }
  const candidate=normalizeRecipient(email);
  return candidate.length<=254 && approved.includes(candidate);
}

/** Explicit activation is held until SMTP/template configuration and email testing are approved. */
export async function handleClassroomAuth(req: Request, config: ClassroomAuthConfig, fetcher: typeof fetch=fetch): Promise<Response> {
  if (req.method !== 'POST') return reply({ok:false,error:'method_not_allowed'},405);
  const url=new URL(req.url);
  // Next development can use localhost internally while the browser uses 127.0.0.1.
  // Use the incoming HTTP Host (not caller-supplied forwarded headers).
  const expectedOrigin=`${url.protocol}//${req.headers.get('host') || url.host}`;
  if (req.headers.get('origin') !== expectedOrigin) return reply({ok:false,error:'invalid_origin'},403);
  if (!req.headers.get('content-type')?.startsWith('application/json')) return reply({ok:false,error:'invalid_request'},400);
  let raw: unknown;
  try { const text=await req.text(); if(text.length>2048) return reply({ok:false,error:'invalid_request'},400); raw=JSON.parse(text); }
  catch { return reply({ok:false,error:'invalid_request'},400); }
  if (!raw || typeof raw!=='object' || Array.isArray(raw)) return reply({ok:false,error:'invalid_request'},400);
  const input=raw as Record<string,unknown>;
  if (input.action==='signout') {
    const response=reply({ok:true});
    for(const name of [CLASSROOM_AUTH_COOKIE,'hsb_group_book_family_access']) response.headers.append('Set-Cookie',`${name}=; HttpOnly; SameSite=Strict; Path=/group-book; Max-Age=0${config.secure?'; Secure':''}`);
    return response;
  }
  if (!config.enabled) return reply({ok:false,error:'auth_not_configured'},503);
  if (typeof input.email!=='string' || !['request','verify'].includes(String(input.action))) return reply({ok:false,error:'invalid_request'},400);
  let email: string=input.email;
  if (process.env.VERCEL_ENV==='preview') {
    // Re-evaluated on every action; generic denial never discloses configuration state.
    if (!previewRecipientAllowed(email, process.env.HSB_CLASSROOM_PREVIEW_RECIPIENTS_JSON)) return reply({ok:false,error:'auth_unavailable'},503);
    email=normalizeRecipient(email);
  }
  try {
    const auth=createManagedClassroomAuth(config.publishableKey,fetcher);
    if(input.action==='request') {await auth.requestCode(email);return reply({ok:true});}
    if(typeof input.code!=='string') return reply({ok:false,error:'invalid_code'},400);
    const session=await auth.verifyCode(email,input.code);
    const response=reply({ok:true});
    response.headers.set('Set-Cookie',`${CLASSROOM_AUTH_COOKIE}=${encodeURIComponent(session.accessToken)}; HttpOnly; SameSite=Strict; Path=/group-book; Max-Age=${session.expiresIn}${config.secure?'; Secure':''}`);
    return response;
  } catch(error) {
    const code=error instanceof Error?error.message:'auth_unavailable';
    const allowed=['invalid_email','invalid_code','auth_not_configured','auth_rate_limited','auth_unavailable'];
    const safe=allowed.includes(code)?code:'auth_unavailable';
    return reply({ok:false,error:safe},safe==='auth_rate_limited'?429:safe.startsWith('invalid_')?400:503);
  }
}
