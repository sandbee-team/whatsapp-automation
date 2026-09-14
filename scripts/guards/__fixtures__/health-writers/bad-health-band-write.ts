// A second, unpinned writer of instance_pacing_state.health_band - must be flagged.
export async function badBandWrite(tx: {
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}) {
  await tx.query(`UPDATE instance_pacing_state SET health_band = 'watch' WHERE instance_id = $1`, [
    'instance-1',
  ]);
}
