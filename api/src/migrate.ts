import pg from 'pg';
import { config } from './config.ts';
import { migrate } from './schema.ts';

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 });
await migrate(pool);
await pool.end();
console.log('migration applied');
