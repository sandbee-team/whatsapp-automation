// Fixture: app/* must never import admin/* (no cross-project import, ever).
// This file deliberately violates no-cross-project.
import { adminMarker } from '../../../admin/frontend/src/index.js';

export const value = adminMarker;
