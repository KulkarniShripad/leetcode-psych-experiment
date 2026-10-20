// Worker for the SQLite concurrency test: its own connection, claiming slots as fast as it can.
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../server/db/connection.js';
import { claimMany } from './claimMany.js';

const { store, count, prefix, start } = workerData;
const db = await openDatabase(store);
Atomics.wait(new Int32Array(start), 0, 0);
const claimed = await claimMany(db, count, prefix);
await db.close();
parentPort.postMessage(claimed);
