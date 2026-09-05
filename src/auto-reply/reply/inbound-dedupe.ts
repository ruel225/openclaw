// Tracks inbound message ids to avoid duplicate reply runs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");
const INBOUND_DEDUPE_INFLIGHT_KEY = Symbol.for("openclaw.inboundDedupeInflight");

const inboundDedupeCache: DedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
const inboundDedupeInFlight = resolveGlobalSingleton(
  INBOUND_DEDUPE_INFLIGHT_KEY,
  () => new Set<string>(),
);

type InboundDedupeOwnership = { key: string; ownerToken: object };

/** Chunk-shared owner→committed-entry association so abandonment can free the entry. */
const INBOUND_DEDUPE_OWNERSHIPS_KEY = Symbol.for("openclaw.inboundDedupeOwnerships");
const inboundDedupeOwnerships = resolveGlobalSingleton(
  INBOUND_DEDUPE_OWNERSHIPS_KEY,
  () => new WeakMap<object, InboundDedupeOwnership>(),
);

type InboundDedupeClaimResult =
  | { status: "invalid" }
  | { status: "duplicate"; key: string }
  | { status: "inflight"; key: string }
  | { status: "claimed"; key: string };

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundDedupeSessionScope(ctx: MsgContext): string {
  const commandTarget = resolveCommandTurnTargetSessionKey(ctx);
  // One command event can target several sessions; dedupe each addressed operation.
  if (commandTarget) {
    return commandTarget;
  }
  const sessionKey = normalizeOptionalString(ctx.SessionKey) || "";
  if (!sessionKey) {
    return "";
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return sessionKey;
  }
  // The same physical inbound message should never run twice for the same
  // agent, even if a routing bug presents it under both main and direct keys.
  return `agent:${parsed.agentId}`;
}

function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider =
    normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface) || "";
  const messageId = normalizeOptionalString(ctx.MessageSid);
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionScope = resolveInboundDedupeSessionScope(ctx);
  const accountId = normalizeOptionalString(ctx.AccountId) ?? "";
  const routeKey = channelRouteDedupeKey({
    channel: provider,
    to: peerId,
    accountId,
    threadId: ctx.MessageThreadId,
  });
  return JSON.stringify([sessionScope, routeKey, messageId]);
}

export function claimInboundDedupe(
  ctx: MsgContext,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Set<string> },
): InboundDedupeClaimResult {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { status: "invalid" };
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  if (cache.peek(key, opts?.now)) {
    return { status: "duplicate", key };
  }
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  if (inFlight.has(key)) {
    return { status: "inflight", key };
  }
  inFlight.add(key);
  return { status: "claimed", key };
}

export function commitInboundDedupe(
  key: string,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Set<string>; owner?: object },
): void {
  const cache = opts?.cache ?? inboundDedupeCache;
  // An owner-tagged commit stays releasable by exactly that owner, so a run the
  // queue relinquishes before admission can free its entry for the retry.
  const ownerToken = opts?.owner ? {} : undefined;
  cache.check(key, opts?.now, ownerToken);
  if (opts?.owner && ownerToken) {
    inboundDedupeOwnerships.set(opts.owner, { key, ownerToken });
  }
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  inFlight.delete(key);
}

export function releaseInboundDedupe(key: string, opts?: { inFlight?: Set<string> }): void {
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  inFlight.delete(key);
}

/**
 * Frees the committed entry an abandoned pre-admission run owns. The durable
 * ingress retry the abandonment triggers must be re-admittable instead of being
 * rejected as a duplicate of the very dispatch the queue just released. The key
 * may have expired and been re-committed by a newer dispatch; only the owner
 * that recorded the current entry may release it.
 */
export function releaseCommittedInboundDedupe(owner: object, opts?: { cache?: DedupeCache }): void {
  const ownership = inboundDedupeOwnerships.get(owner);
  if (!ownership) {
    return;
  }
  inboundDedupeOwnerships.delete(owner);
  (opts?.cache ?? inboundDedupeCache).delete(ownership.key, ownership.ownerToken);
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
  inboundDedupeInFlight.clear();
}
