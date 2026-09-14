/* eslint-disable */
// send-load.k6.mjs (P26 U2b, step 2) - k6 load-test script.
//
// NOT EXECUTED in P26: there is no k6 binary on the measurement host used
// this session. The Node driver (`app/backend/src/engine/measure/
// send-load-driver.ts`) produced this session's load-test artifacts instead.
// Both this script and the Node driver read the SAME mix file
// (`scripts/loadtest/tenant-mix.json`, documented in the sibling
// `tenant-mix.ts` module) so a future run with a real k6 binary reproduces
// the identical tenant shape.
//
// Run (once k6 is available):
//   k6 run scripts/loadtest/send-load.k6.mjs -e BASE_URL=https://... -e TOKEN=...
//
// This file is plain JS, not part of the TypeScript project (k6's own
// runtime is a Go-embedded JS engine, not Node - it cannot import compiled
// TS, and is not linted/type-checked by this repo's TS toolchain).

import http from 'k6/http';
import { check } from 'k6';

const mix = JSON.parse(open('./tenant-mix.json'));

function buildScenarios(mixSpec) {
  const scenarios = {};
  for (const tenant of mixSpec.tenants) {
    const ratePerSecond = (tenant.instances * tenant.sendsPerDayPerInstance) / 86400;
    scenarios[`steady_${tenant.key}`] = {
      executor: 'constant-arrival-rate',
      rate: Math.max(1, Math.round(ratePerSecond * 60)),
      timeUnit: '1m',
      duration: '30m',
      preAllocatedVUs: Math.max(1, tenant.instances),
      maxVUs: Math.max(10, tenant.instances * 2),
      exec: 'sendSteady',
      tags: { tenant: tenant.key },
      env: { TENANT_KEY: tenant.key },
    };
  }
  if (mixSpec.burstTenant) {
    scenarios.burst = {
      executor: 'shared-iterations',
      vus: Math.max(1, mixSpec.burstTenant.instances),
      iterations: mixSpec.burstTenant.recipients,
      startTime: `${mixSpec.burstTenant.startAtSeconds}s`,
      maxDuration: '10m',
      exec: 'sendBurst',
      tags: { tenant: mixSpec.burstTenant.key },
    };
  }
  return scenarios;
}

export const options = {
  scenarios: buildScenarios(mix),
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TOKEN = __ENV.TOKEN || '';

function sendOne(tenantKey) {
  const res = http.post(
    `${BASE_URL}/api/v1/messages`,
    JSON.stringify({
      recipient: { jid: `${Date.now()}${Math.floor(Math.random() * 1e6)}@s.whatsapp.net` },
      payload: { text: 'load-test' },
      idempotencyKey: `${tenantKey}-${Date.now()}-${Math.random()}`,
    }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      tags: { tenant: tenantKey },
    },
  );
  check(res, {
    'status is 200 or 202': (r) => r.status === 200 || r.status === 202,
  });
}

export function sendSteady() {
  sendOne(__ENV.TENANT_KEY || 'unknown');
}

export function sendBurst() {
  sendOne(mix.burstTenant ? mix.burstTenant.key : 'burst');
}
