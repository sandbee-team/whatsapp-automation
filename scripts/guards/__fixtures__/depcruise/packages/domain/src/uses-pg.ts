// Fixture: packages/domain must never import pg/ioredis (npm) or Node core
// builtins. This file deliberately violates domain-must-be-pure-npm.
import { Client } from 'pg';
import Redis from 'ioredis';

export const client = new Client();
export const redis = new Redis();
