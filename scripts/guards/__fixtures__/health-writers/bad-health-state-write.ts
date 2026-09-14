// A second, unpinned writer of whatsapp_instances.health_state - must be flagged.
export async function badResume(tx: {
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}) {
  await tx.query(`UPDATE whatsapp_instances SET health_state = 'connected' WHERE id = $1`, [
    'instance-1',
  ]);
}
