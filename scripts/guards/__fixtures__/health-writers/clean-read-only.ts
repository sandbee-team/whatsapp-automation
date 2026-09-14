// A read (WHERE clause only) of health_state / health_band - never a write, never flagged.
export async function readHealthState(tx: {
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}) {
  await tx.query(`SELECT id FROM whatsapp_instances WHERE health_state = 'connected'`, []);
  await tx.query(`SELECT id FROM instance_pacing_state WHERE health_band = 'watch'`, []);
}
