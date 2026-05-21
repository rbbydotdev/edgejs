import type { Policy } from "./index";
import { HTTPS_AS_HTTP_SOURCE } from "../overrides/https-as-http";

// Server-side https → http delegation.  See overrides/https-as-http.ts for
// the source string and the architectural rationale (the Service Worker is
// the TLS endpoint to the user-agent, so the wasm only ever sees pre-parsed
// HTTP through the SW bridge).
//
// This policy ONLY affects inbound (`https.createServer`).  Outbound client
// behavior (`https.request`, `https.get`) is owned by the outbound-* policy
// applied later in the array.  The two are kept separate so a deployment
// can mix-and-match (e.g. SW-bridged inbound + fetch-tunneled outbound).

export const inboundHttpsViaSW: Policy = {
  name: "inbound-https-via-sw",
  description: "https.createServer delegates to http; cert/key options silently ignored (SW is the TLS endpoint).",
  builtinOverrides: { https: HTTPS_AS_HTTP_SOURCE },
};
