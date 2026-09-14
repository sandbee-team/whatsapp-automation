// Fixture (P15 C1 FIX F8 / MAJ-6) - a file that calls SOME OTHER object's
// publish-shaped method (an unrelated pub/sub-shaped API, e.g. a message
// bus with no import of the realtime bridge module's own publisher pieces
// at all) - the widened guard must never flag this: it only fires for files
// whose import list actually reaches the redis-bridge module's publisher
// factory/type.
export function unrelatedPublish(bus: { publish: (topic: string) => void }): void {
  bus.publish('some-other-topic');
}
