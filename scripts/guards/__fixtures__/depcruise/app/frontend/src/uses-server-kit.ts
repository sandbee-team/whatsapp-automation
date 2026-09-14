// Fixture: no frontend may import packages/server-kit or db directly. This
// file deliberately violates frontend-never-server.
import { serverKitMarker } from '../../../packages/server-kit/src/index.js';

export const value = serverKitMarker;
