import { registerRoute } from '../../../../app/backend/src/platform/http/route-policy.js';

// Fixture (go-live U3): declares `session_or_api_key` on a URL other than
// `/v1/messages` - the one route this policy is allowed on.
registerRoute(app, deps, {
  method: 'GET',
  path: '/v1/not-messages',
  policy: 'session_or_api_key',
  scope: 'test:not-messages',
  handler: async () => {},
});
