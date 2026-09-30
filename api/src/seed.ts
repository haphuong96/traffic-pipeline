import pg from 'pg';
import { config } from './config.ts';
import { seedDevices } from './devices.ts';

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
const inserted = await seedDevices(pool, config.seedDeviceCount);
await pool.end();
console.log(`seeded ${inserted} new devices (${config.seedDeviceCount} total requested)`);
