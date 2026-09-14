Dev/demo seed data (never runs against prod), arriving P02+.

- `demo-plan-assign.sql` - assigns the fixed "Demo plan (dev only)" plan (id
  `d0000000-0000-4000-d000-000000000001`) to the workspace owned by a given
  email (`-v demo_email='<email>'`), unblocking a fresh signup's `no_plan`
  409s (contacts/instances/broadcasts) until P28 ships real plan assignment.
  Refuses when the email matches no client. See the file header for the
  exact invocation.
- `dev-orphan-instances-remove.sql` - removes orphan `whatsapp_instances`
  left behind by e2e/integration test runs (live, `desired_state='online'`,
  no `instance_pacing_state` row, not a `queue-explain-fixture.sql` id) that
  block the session-worker boot gate; refuses if the matched set is empty or
  if any matched instance still carries a `whatsapp_session_credentials` row.
  Run after `queue-explain-fixture-remove.sql`. See the file header for the
  exact invocation and operation order.
