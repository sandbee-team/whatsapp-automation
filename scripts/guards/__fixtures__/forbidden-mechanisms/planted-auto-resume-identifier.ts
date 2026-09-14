/** Planted violation: an `autoResume` identifier anywhere in the tree is forbidden (core invariant 6). */
export function autoResume(instanceId: string): void {
  console.log(`pretending to auto-resume ${instanceId}`);
}
