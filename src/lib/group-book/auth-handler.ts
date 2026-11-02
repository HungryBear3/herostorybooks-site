import {createManagedClassroomAuth, CLASSROOM_AUTH_COOKIE} from './managed-auth.ts';

export interface ClassroomAuthConfig { enabled: boolean; publishableKey: string; secure: boolean }
const headers = {'Cache-Control':'no-store, private','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow, noarchive'};
const reply = (body: object, status=200) => Response.json(body,{status,headers});
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
  try {
    const auth=createManagedClassroomAuth(config.publishableKey,fetcher);
    if(input.action==='request') {await auth.requestCode(input.email);return reply({ok:true});}
    if(typeof input.code!=='string') return reply({ok:false,error:'invalid_code'},400);
    const session=await auth.verifyCode(input.email,input.code);
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
