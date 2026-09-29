/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as board from "../board.js";
import type * as discovery from "../discovery.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as intake from "../intake.js";
import type * as lib_agentmail from "../lib/agentmail.js";
import type * as lib_agentmailRest from "../lib/agentmailRest.js";
import type * as lib_authz from "../lib/authz.js";
import type * as lib_domains from "../lib/domains.js";
import type * as lib_events from "../lib/events.js";
import type * as lib_fx from "../lib/fx.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_mx from "../lib/mx.js";
import type * as lib_openai from "../lib/openai.js";
import type * as lib_password from "../lib/password.js";
import type * as lib_rfqText from "../lib/rfqText.js";
import type * as lib_seedSuppliers from "../lib/seedSuppliers.js";
import type * as lib_svix from "../lib/svix.js";
import type * as recommendations from "../recommendations.js";
import type * as requests from "../requests.js";
import type * as rfqs from "../rfqs.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  board: typeof board;
  discovery: typeof discovery;
  http: typeof http;
  inbound: typeof inbound;
  intake: typeof intake;
  "lib/agentmail": typeof lib_agentmail;
  "lib/agentmailRest": typeof lib_agentmailRest;
  "lib/authz": typeof lib_authz;
  "lib/domains": typeof lib_domains;
  "lib/events": typeof lib_events;
  "lib/fx": typeof lib_fx;
  "lib/money": typeof lib_money;
  "lib/mx": typeof lib_mx;
  "lib/openai": typeof lib_openai;
  "lib/password": typeof lib_password;
  "lib/rfqText": typeof lib_rfqText;
  "lib/seedSuppliers": typeof lib_seedSuppliers;
  "lib/svix": typeof lib_svix;
  recommendations: typeof recommendations;
  requests: typeof requests;
  rfqs: typeof rfqs;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
