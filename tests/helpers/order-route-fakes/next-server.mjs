/**
 * The one thing `src/app/api/order/route.ts` uses from `next/server`.
 *
 * `NextResponse.json` is a thin wrapper over the platform Response, so the
 * route under test returns a real Response and the scenario reads a real
 * status and body. Nothing else from next/server is reachable from the route.
 */
export const NextResponse = {
  json(body, init) {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  },
};
