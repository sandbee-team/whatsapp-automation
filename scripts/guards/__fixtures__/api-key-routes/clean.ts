import { registerRoute } from '../../../../app/backend/src/platform/http/route-policy.js';

// Fixture (go-live U3): declares `session_or_api_key` on the one allowed URL.
registerRoute(app, deps, {
  method: 'POST',
  path: '/v1/messages',
  policy: 'session_or_api_key',
  scope: 'messages:send',
  handler: async () => {},
});
