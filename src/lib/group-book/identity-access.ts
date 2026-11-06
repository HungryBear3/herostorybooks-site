import {createHash} from 'node:crypto';
import {put} from '@vercel/blob';
import {groupBookInvites, groupBookInvitesStrict, resolveGroupBookInviteState, type GroupBookInvite, type GroupBookInviteState} from './config.ts';
import {createManagedClassroomAuth, CLASSROOM_AUTH_COOKIE, CLASSROOM_AUTH_URL} from './managed-auth.ts';
import {readPrivateObject, requireToken} from './store.ts';
import {groupBookAdmission} from './release.ts';
import type {VerifiedGroupBookPrincipal} from './ownership.ts';
import {admitGroupBookIntakePurpose, bindGroupBookCohortPurpose} from './pilot-retention.ts';

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
export const CLASSROOM_CODES_ENV='HSB_CLASSROOM_CODES_JSON';
export type ClassroomCohort=Omit<GroupBookInvite,'familySlotId'>;
export type ClassroomCodesConfig=
  | {state:'absent'}
  | {state:'valid';cohorts:ClassroomCohort[]}
  | {state:'malformed'};
/** Strict selector configuration: unset is absent; anything unparseable or ambiguous is malformed, never empty. */
export function classroomCodesStrict(raw:string|undefined=process.env[CLASSROOM_CODES_ENV]):ClassroomCodesConfig {
  if(!raw?.trim()) return {state:'absent'};
  let rows:unknown;
  try{rows=JSON.parse(raw);}catch{return {state:'malformed'};}
  if(!Array.isArray(rows) || rows.some(r=>!r || typeof r!=='object' || Array.isArray(r) || 'owner' in r || 'familySlotId' in r)) return {state:'malformed'};
  if(rows.length===0) return {state:'valid',cohorts:[]};
  // Reuse the strict invite parser; reject ambiguous tokens/cohorts and all owner fields.
  const parsed=groupBookInvitesStrict(JSON.stringify(rows.map(r=>({...r,familySlotId:'classroom_selector'}))));
  if(parsed.state!=='valid' || parsed.invites.length!==rows.length) return {state:'malformed'};
  if(parsed.invites.some(r=>groupBookInvites().some(i=>i.token===r.token))) return {state:'malformed'};
  if(parsed.invites.some(r=>groupBookInvites().some(i=>i.cohortId===r.cohortId && (i.purpose??'fullbook')!==(r.purpose??'fullbook')))) return {state:'malformed'};
  return {state:'valid',cohorts:parsed.invites};
}
function classroomCodes():ClassroomCohort[] {
  const strict=classroomCodesStrict();
  return strict.state==='valid' ? strict.cohorts : [];
}

/** Domain-separated managed enrollment identity; disjoint from operator-provisioned legacy slots. */
export function classroomEnrollmentIdentity(cohortId:string,issuer:string,subject:string):string {
  return createHash('sha256').update(JSON.stringify(['classroom-v1',cohortId,issuer,subject])).digest('hex');
}
export const CLASSROOM_ENROLLMENT_PREFIX='group-book/enrollments/';
export function classroomEnrollmentPath(identity:string):string {
  return `${CLASSROOM_ENROLLMENT_PREFIX}${identity}.json`;
}
export interface ClassroomEnrollment {cohortId:string;familySlotId:string;owner:{issuer:string;subject:string}}
const ENROLLMENT_PATH_RE=/^group-book\/enrollments\/([0-9a-f]{64})\.json$/;
const COHORT_RE=/^[A-Za-z0-9_-]{3,64}$/;
const SUBJECT_RE=/^[A-Za-z0-9_-]{1,128}$/;
/** Canonical enrollment pathname grammar (the exact one parseClassroomEnrollment enforces), checkable before any read. */
export function isClassroomEnrollmentPath(pathname:unknown):pathname is string {
  return typeof pathname==='string' && ENROLLMENT_PATH_RE.test(pathname);
}
const exactKeys=(value:unknown,keys:string[]):value is Record<string,unknown> =>
  Boolean(value) && typeof value==='object' && !Array.isArray(value) &&
  Object.keys(value as object).length===keys.length && keys.every(k=>Object.hasOwn(value as object,k));
/** Strict stored-enrollment parser: canonical path, exact shape, pinned issuer, path = slot = recomputed identity. */
export function parseClassroomEnrollment(pathname:string,value:unknown):ClassroomEnrollment|null {
  const pathIdentity=ENROLLMENT_PATH_RE.exec(pathname)?.[1];
  if(!pathIdentity) return null;
  if(!exactKeys(value,['schemaVersion','cohortId','familySlotId','owner']) || value.schemaVersion!==1) return null;
  const {cohortId,familySlotId,owner}=value;
  if(typeof cohortId!=='string' || !COHORT_RE.test(cohortId) || typeof familySlotId!=='string') return null;
  if(!exactKeys(owner,['issuer','subject'])) return null;
  const {issuer,subject}=owner;
  if(issuer!==CLASSROOM_AUTH_URL || typeof subject!=='string' || !SUBJECT_RE.test(subject)) return null;
  if(familySlotId!==pathIdentity || classroomEnrollmentIdentity(cohortId,issuer,subject)!==pathIdentity) return null;
  return {cohortId,familySlotId,owner:{issuer,subject}};
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
  const identity=classroomEnrollmentIdentity(cohort.cohortId,principal.issuer,principal.subject);
  const familySlotId=identity;
  // Do not attach a new managed owner to a pre-existing capability slot.
  if(groupBookInvites().some(i=>i.cohortId===cohort.cohortId && i.familySlotId===familySlotId)) return {state:'unknown'};
  const owner={issuer:principal.issuer,subject:principal.subject};
  const expected={schemaVersion:1,cohortId:cohort.cohortId,familySlotId,owner};
  const path=classroomEnrollmentPath(identity);
  try {
    let read=await readPrivateObject(path);
    if(read.state==='absent' && enroll && groupBookAdmission().open) {
      const binding=await bindGroupBookCohortPurpose(cohort,Date.now());
      if(binding.state!=='registered' || binding.record.purpose!==(cohort.purpose??'fullbook')) return {state:'unknown'};
      const purpose=await admitGroupBookIntakePurpose({...cohort,familySlotId,owner},Date.now(),false);
      if(purpose.state!=='fullbook' && purpose.state!=='pilot') return {state:'unknown'};
      try {await put(path,JSON.stringify(expected),{access:'private',token:requireToken(),addRandomSuffix:false,allowOverwrite:false,cacheControlMaxAge:0,contentType:'application/json'});}catch{/* reconcile uncertain commit or concurrent enrollment */}
      read=await readPrivateObject(path);
    }
    if(read.state!=='found') return {state:'unknown'};
    const row=read.value as typeof expected;
    if(!row || row.schemaVersion!==1 || row.cohortId!==expected.cohortId || row.familySlotId!==familySlotId || row.owner?.issuer!==owner.issuer || row.owner?.subject!==owner.subject) return {state:'unknown'};
    return {state:'active',invite:{...cohort,familySlotId,owner}};
  }catch{return {state:'unknown'};}
}
