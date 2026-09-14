import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerAdminRoute } from '../../platform/http/route-policy.js';
import { requestIdFor, sendError, sendSuccess } from '../../platform/http/error-mapper.js';
import type { StaffAuthDeps } from '../../platform/http/staff-auth-plugin.js';
import { evaluateBotGuard, hashIp } from './bot-guard.js';
import {
  applyRateLimitHeaders,
  LeadRateLimitedError,
  type PublicLeadsRateLimiter,
} from './public-rate-limit.js';
import type { LeadsRepo } from './leads.repo.js';

/**
 * modules/leads/leads.routes.ts (P29 U4b) - the ONE unauthenticated write
 * route in admin-backend: the marketing site's contact form. Deliberately
 * NOT built on `registerAdminRoute`'s `'staff'` policy - a visitor
 * submitting the form has no staff session, no tenant, and there is no
 * `platformRead`/`StaffCtx` on this path at all. Both routes still go
 * through `registerAdminRoute` with `policy: 'public'`, so the fail-closed
 * `onRoute` hook still fires and an unpoliced route still throws at boot.
 *
 * Per-request order, and why: (1) CORS decided first, so every branch below
 * gets the right headers; (2) rate limit BEFORE body parsing - a Fastify
 * `onRequest` hook (which runs before Fastify's own body parser) checks the
 * limiter and, on denial, sends the 429 itself and returns - the flood of a
 * denied request's body is never even read into memory, and the 16 KiB
 * `bodyLimit` set on the POST route below rejects an oversized body (413)
 * before parsing too; (3) schema validation, inside the handler; (4) the bot
 * guard, which responds with the EXACT SAME 202 body a genuine submission
 * gets - a bot (or its operator watching for a distinguishing response)
 * learns nothing from the response shape; (5) the write, keyed by a hashed
 * IP only.
 *
 * Nothing here is logged beyond a request id and a coarse outcome enum
 * (`deps.onOutcome`) - never name/email/phone/message/IP (api.md).
 */

const utmSchema = z
  .record(z.string().regex(/^[a-z_]{1,32}$/), z.string().max(200))
  .refine((utm) => Object.keys(utm).length <= 10, {
    message: 'utm may carry at most 10 keys',
  })
  .refine((utm) => Buffer.byteLength(JSON.stringify(utm), 'utf8') <= 1800, {
    // 1800 leaves headroom under migration 0074's storage-layer CHECK
    // (`pg_column_size(utm) <= 2048`, which includes jsonb overhead) - a
    // payload accepted here must never fail only once it reaches storage.
    message: 'utm too large',
  });

const leadBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).toLowerCase().pipe(z.email()),
    company: z.string().trim().max(120).optional(),
    phoneE164: z
      .string()
      .regex(/^\+[1-9][0-9]{7,14}$/)
      .optional(),
    message: z.string().trim().min(1).max(2000),
    source: z.string().regex(/^[a-z0-9-]{1,64}$/),
    utm: utmSchema.optional(),
    /**
     * The honeypot. A real visitor's browser never fills this in (hidden
     * field), but a non-empty value must still reach the bot guard rather
     * than fail schema validation - a 400 here would let a bot (or its
     * operator) distinguish "caught by the honeypot" from "rejected for an
     * unrelated reason" by response shape, defeating the point of
     * responding identically either way (see the module header).
     */
    website: z.string().max(200),
    /** Client-reported form-render timestamp (epoch ms) - the bot guard's minimum-elapsed-time check. */
    startedAt: z.number().int().positive(),
  })
  .strict();

export interface LeadsRoutesDeps {
  auth: StaffAuthDeps;
  repo: LeadsRepo;
  /** Exact site origin(s) allowed to POST this route - never a wildcard. */
  allowedOrigins: readonly string[];
  /** Keys the HMAC that replaces the raw IP (see `bot-guard.ts#hashIp`) - a dedicated secret, never `ADMIN_JWT_SECRET`. */
  ipHashSecret: string;
  now: () => Date;
  limiter: PublicLeadsRateLimiter;
  onOutcome?: (outcome: 'accepted' | 'bot_rejected' | 'rate_limited' | 'invalid') => void;
}

const LEADS_PATH = '/public/v1/leads';
const CORS_MAX_AGE_SECONDS = 600;
/** 16 KiB comfortably covers the largest valid body (name/company/message/utm all capped) with headroom - well under Fastify's 1 MiB default. */
const LEADS_POST_BODY_LIMIT_BYTES = 16 * 1024;

function applyCors(
  reply: FastifyReply,
  origin: string | undefined,
  allowed: readonly string[],
): void {
  if (origin && allowed.includes(origin)) {
    // Never `Access-Control-Allow-Credentials` - this route accepts no
    // cookies and issues none.
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
}

/** Body accepted by an unaccepted `202` response - accepted, honeypot-rejected and rate-limited-avoided-writes all share this exact shape (see the module header on why bot rejection must be indistinguishable). */
function acceptedBody(): { accepted: true } {
  return { accepted: true };
}

/**
 * The 413 for a body over `LEADS_POST_BODY_LIMIT_BYTES` is Fastify's own
 * pre-handler response (`FST_ERR_CTP_BODY_TOO_LARGE`), not the admin
 * envelope: it carries no requestId and no CORS header. It leaks nothing
 * (generic Fastify text) and is the one admin response that bypasses
 * `error-mapper.ts` - stated here so nobody hunts for the envelope.
 */

/** True for the exact leads POST request this hook must gate - never the OPTIONS preflight or any other route sharing this Fastify instance. */
function isLeadsPost(req: FastifyRequest): boolean {
  return req.method === 'POST' && req.routeOptions.url === LEADS_PATH;
}

/**
 * Registered as a global `onRequest` hook (see `registerLeadsRoutes`) so the
 * rate-limit decision is made before Fastify's body parser ever runs - a
 * denied request's body is never read. Scoped to the exact POST route by
 * `isLeadsPost`; every other route on this Fastify instance passes through
 * untouched.
 */
function rateLimitBeforeParsing(
  deps: LeadsRoutesDeps,
): (req: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void {
  return (req, reply, done) => {
    if (!isLeadsPost(req)) {
      done();
      return;
    }

    // An oversized (413) request also spends a token here: the limiter runs
    // before the body is read, so a body that is later refused as too large
    // still counts. That is the safer ordering - a flood of oversized bodies
    // is exactly what the limiter must throttle.
    const decision = deps.limiter.check(req.ip);
    applyRateLimitHeaders(reply, decision);
    if (!decision.allowed) {
      deps.onOutcome?.('rate_limited');
      // CORS must be on the 429 too, or the browser sees an opaque network
      // failure and the form cannot show its "too many attempts" copy.
      applyCors(reply, req.headers.origin, deps.allowedOrigins);
      sendError(reply, requestIdFor(req), new LeadRateLimitedError(decision));
      // Deliberately never call `done()` here - the reply is already sent,
      // and calling `done()` after `reply.send()` would let Fastify's hook
      // chain continue toward body parsing regardless.
      return;
    }
    done();
  };
}

export function registerLeadsRoutes(app: FastifyInstance, deps: LeadsRoutesDeps): void {
  app.addHook('onRequest', rateLimitBeforeParsing(deps));

  registerAdminRoute(app, deps.auth, {
    method: 'OPTIONS',
    path: LEADS_PATH,
    policy: 'public',
    handler: (req, reply) => {
      const origin = req.headers.origin;
      applyCors(reply, origin, deps.allowedOrigins);
      if (origin && deps.allowedOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'content-type');
        reply.header('Access-Control-Max-Age', String(CORS_MAX_AGE_SECONDS));
      }
      reply.code(204).send();
    },
  });

  registerAdminRoute(app, deps.auth, {
    method: 'POST',
    path: LEADS_PATH,
    policy: 'public',
    bodyLimit: LEADS_POST_BODY_LIMIT_BYTES,
    handler: async (req, reply) => {
      const requestId = requestIdFor(req);
      applyCors(reply, req.headers.origin, deps.allowedOrigins);

      const parsed = leadBodySchema.parse(req.body);

      const guard = evaluateBotGuard({
        honeypot: parsed.website,
        startedAtMs: parsed.startedAt,
        nowMs: deps.now().getTime(),
      });
      if (!guard.ok) {
        deps.onOutcome?.('bot_rejected');
        sendSuccess(reply, requestId, acceptedBody(), 202);
        return;
      }

      const ipHash = hashIp(deps.ipHashSecret, req.ip);
      await deps.repo.insert({
        name: parsed.name,
        email: parsed.email,
        company: parsed.company ?? null,
        phoneE164: parsed.phoneE164 ?? null,
        message: parsed.message,
        source: parsed.source,
        utm: parsed.utm ?? {},
        ipHash,
      });
      deps.onOutcome?.('accepted');
      sendSuccess(reply, requestId, acceptedBody(), 202);
    },
  });
}
