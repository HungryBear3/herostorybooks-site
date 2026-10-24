import type { GroupBookInvite } from './config.ts';
export interface VerifiedGroupBookPrincipal { issuer: string; subject: string; emailVerified: boolean }
/** Server-internal input only: never construct a principal from request JSON,
 * a decoded/unverified JWT, a contact email, or organizer authority. */
export function ownsGroupBookInvite(invite: GroupBookInvite, principal: VerifiedGroupBookPrincipal | null): boolean {
  if (invite.owner === undefined) return true; // explicit legacy capability lane
  return principal?.emailVerified === true &&
    principal.issuer === invite.owner.issuer && principal.subject === invite.owner.subject;
}
