import { SetMetadata } from "@nestjs/common";

/**
 * Marks a route as reachable without a Bearer token ONLY when the deployment
 * is a local-serve (loopback) bind — the same posture the loopback HUD page and
 * its snapshot already use. On a non-local bind the route falls through to the
 * normal service-token / OIDC check, so authentication is preserved in
 * production. See `ServiceTokenGuard`.
 */
export const LOCAL_LOOPBACK_ROUTE = "jarvis:local-loopback-route";
export const LocalLoopbackRoute = () => SetMetadata(LOCAL_LOOPBACK_ROUTE, true);
