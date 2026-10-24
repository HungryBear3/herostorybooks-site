import {createHash} from 'node:crypto';
import {put} from '@vercel/blob';
import {groupBookInvites, resolveGroupBookInviteState, type GroupBookInvite, type GroupBookInviteState} from './config.ts';
import {createManagedClassroomAuth, CLASSROOM_AUTH_COOKIE, CLASSROOM_AUTH_URL} from './managed-auth.ts';
import {readPrivateObject, requireToken} from './store.ts';
import {groupBookAdmission} from './release.ts';
import type {VerifiedGroupBookPrincipal} from './ownership.ts';

export function cookieValue(header:string,name:string):string {
  const values=header.split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${name}=`));
  if(values.length!==1) return '';
  try{return decodeURIComponent(values[0].slice(name.length+1));}catch{return '';}
}
export async function classroomPrincipal(cookieHeader:string):Promise<VerifiedGroupBookPrincipal|null> {
  if(process.env.HSB_CLASSROOM_AUTH_ENABLED!=='true') return null;
  const token=cookieValue(cookieHeader,CLASSROOM_AUTH_COOKIE);
  if(!token) return null;
  try{return await createManagedClassroomAuth(process.env.HSB_CLASSROOM_SUPABASE_PUBLISHABLE_KEY??'').principal(token);}catch{return null;}
}
/** Browser-bound mutations require Origin; legacy non-session capability callers stay compatible. */
export function classroomOriginAllowed(req:Request):boolean {
  if(!cookieValue(req.headers.get('cookie')??'',CLASSROOM_AUTH_COOKIE)) return true;
  const u=new URL(req.url);
  return req.headers.get('origin')===`${u.protocol}//${req.headers.get('host')||u.host}`;
}
function classroomCodes():Omit<GroupBookInvite,'familySlotId'>[] {
  try {
    const rows:unknown=JSON.parse(process.env.HSB_CLASSROOM_CODES_JSON??'[]');
    if(!Array.isArray(rows)) return [];
    // Reuse the strict invite parser; reject ambiguous tokens/cohorts and all owner fields.
    const parsed=groupBookInvites(JSON.stringify(rows.map(r=>({...r,familySlotId:'classroom_selector'}))));
    if(parsed.length!==rows.length || rows.some(r=>!r || typeof r!=='object' || 'owner' in r || 'familySlotId' in r)) return [];
    if(parsed.some(r=>groupBookInvites().some(i=>i.token===r.token))) return [];
    return parsed;
  }catch{return [];}
}
/** Shared selector is never a family capability. Identity comes only from online /user.
 * Immutable create-only enrollment reuses the dedicated private Blob store: no hosted SQL migration.
 * Domain separation keeps this namespace disjoint from operator-provisioned legacy family slots.
 */
export async function resolveGroupBookSessionInvite(token:string,cookieHeader='',enroll=false):Promise<GroupBookInviteState> {
  const legacy=groupBookInvites().find(i=>i.token===token);
  if(legacy) return resolveGroupBookInviteState(token,Date.now(),legacy.owner?await classroomPrincipal(cookieHeader):null);
  const cohort=classroomCodes().find(c=>c.token===token);
  if(!cohort) return {state:'unknown'};
  const principal=await classroomPrincipal(cookieHeader);
  if(!principal || principal.issuer!==CLASSROOM_AUTH_URL) return {state:'unknown'};
  if(cohort.revokedAt && Date.parse(cohort.revokedAt)<=Date.now()) return {state:'unknown'};
  if(Date.parse(cohort.expiresAt)<=Date.now()) return {state:'unknown'};
  const identity=createHash('sha256').update(JSON.stringify(['classroom-v1',cohort.cohortId,principal.issuer,principal.subject])).digest('hex');
  const familySlotId=identity;
  // Do not attach a new managed owner to a pre-existing capability slot.
  if(groupBookInvites().some(i=>i.cohortId===cohort.cohortId && i.familySlotId===familySlotId)) return {state:'unknown'};
  const owner={issuer:principal.issuer,subject:principal.subject};
  const expected={schemaVersion:1,cohortId:cohort.cohortId,familySlotId,owner};
  const path=`group-book/enrollments/${identity}.json`;
  try {
    let read=await readPrivateObject(path);
    if(read.state==='absent' && enroll && groupBookAdmission().open) {
      try {await put(path,JSON.stringify(expected),{access:'private',token:requireToken(),addRandomSuffix:false,allowOverwrite:false,cacheControlMaxAge:0,contentType:'application/json'});}catch{/* reconcile uncertain commit or concurrent enrollment */}
      read=await readPrivateObject(path);
    }
    if(read.state!=='found') return {state:'unknown'};
    const row=read.value as typeof expected;
    if(!row || row.schemaVersion!==1 || row.cohortId!==expected.cohortId || row.familySlotId!==familySlotId || row.owner?.issuer!==owner.issuer || row.owner?.subject!==owner.subject) return {state:'unknown'};
    return {state:'active',invite:{...cohort,familySlotId,owner}};
  }catch{return {state:'unknown'};}
}
