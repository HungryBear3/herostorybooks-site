// Client-safe intake limits shared by the browser preparer and the server.
//
// Vercel Functions reject request bodies over 4.5 MB before the handler runs,
// with a non-JSON 413. Prepared photos are therefore capped so that the full
// multipart request (all photos plus text fields and boundaries) stays under
// that limit; the server re-checks every cap and never trusts the client.

export const MAX_GROUP_BOOK_PHOTOS = 5;
/** Per prepared (browser re-encoded) photo. */
export const MAX_PREPARED_PHOTO_BYTES = 800_000;
/** Whole multipart request, kept below the 4.5 MB platform body limit. */
export const MAX_INTAKE_REQUEST_BYTES = 4_200_000;
/** Longest edge produced by the browser preparer. */
export const PREPARED_PHOTO_MAX_DIMENSION = 1600;

/**
 * The only types advertised to parents. HEIC/HEIF is not advertised: server
 * decoding is unqualified and browser conversion is device-dependent.
 */
export const GROUP_BOOK_ACCEPTED_PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Intake writer lifetime. The intake route exports `maxDuration` with this
 * value (Next route-segment config; the platform ends the invocation there).
 * Literal duplicated in the route because Next requires a static literal.
 */
export const GROUP_BOOK_INTAKE_MAX_DURATION_S = 60;
/**
 * No photo put and no record commit is STARTED after admittedAt + this
 * window, and every photo put is aborted at the window's end. Abort ends the
 * local SDK retry loop; it does not prove the provider did not commit, which
 * is why retention re-verifies every declared key on every scheduled pass.
 */
export const GROUP_BOOK_INTAKE_WRITE_WINDOW_MS = 45_000;
