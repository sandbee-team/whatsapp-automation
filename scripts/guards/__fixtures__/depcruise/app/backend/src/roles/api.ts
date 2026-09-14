// Fixture: the API role must never import the provider directly - it only
// creates durable jobs (core invariant 1). This file deliberately violates
// api-never-imports-provider.
import { send } from '../provider/baileys/send.js';

export function handleRequest(): void {
  send();
}
