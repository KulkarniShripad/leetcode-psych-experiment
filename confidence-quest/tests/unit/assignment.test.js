import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../server/db/connection.js';
import { migrate } from '../../server/db/migrate.js';
import { ensureAllocation, generateBlock, generateSlots } from '../../server/services/assignment.js';
import { freshStore, onPostgres } from '../helpers.js';
import { claimMany } from './claimMany.js';

const armDifference = (slots) => Math.abs(slots.filter((s) => s.arm === 'control').length - slots.filter((s) => s.arm === 'experimental').length);

describe('allocation list', () => {
  it('1,000 simulated runs of 50 participants are always within 1 (block size 2)', () => {
    for (let run = 0; run < 1000; run++) {
      const slots = generateSlots(`sim-${run}`, 'main', 2, 50).slice(0, 50);
      expect(armDifference(slots)).toBeLessThanOrEqual(1);
    }
  });

  it('with block size 4 the difference can reach 2 but never more', () => {
    let worst = 0;
    for (let run = 0; run < 1000; run++) {
      for (const n of [49, 50]) worst = Math.max(worst, armDifference(generateSlots(`sim4-${run}`, 'main', 4, n).slice(0, n)));
    }
    expect(worst).toBe(2);
  });

  it('every block is balanced and the list is reproducible from the seed', () => {
    const a = generateSlots('seed-x', 'main', 4, 60);
    const b = generateSlots('seed-x', 'main', 4, 60);
    expect(a).toEqual(b);
    for (let block = 1; block <= 15; block++) {
      expect(armDifference(a.filter((s) => s.block_no === block))).toBe(0);
    }
    expect(generateSlots('seed-y', 'main', 4, 60)).not.toEqual(a);
    expect(generateSlots('seed-x', 'pilot', 4, 60)).not.toEqual(a);
  });

  it('is not biased towards either arm', () => {
    let control = 0;
    for (let block = 1; block <= 4000; block++) if (generateBlock('bias', 'main', block, 2)[0] === 'control') control++;
    expect(control).toBeGreaterThan(1850);
    expect(control).toBeLessThan(2150);
  });

  it('separate connections claiming at the same instant never take the same slot', async () => {
    const store = await freshStore();
    const setup = await openDatabase(store);
    await migrate(setup);
    await ensureAllocation(setup, { block_size: 2, main_slots: 40, pilot_slots: 4, separate_pilot_list: true }, 'concurrency-seed');
    await setup.close();

    const workers = 8;
    const perWorker = 15;
    let claimed;
    if (onPostgres) {
      // Postgres: eight connection pools in this process, all claiming at once.
      const dbs = await Promise.all(Array.from({ length: workers }, () => openDatabase(store)));
      claimed = (await Promise.all(dbs.map((db, w) => claimMany(db, perWorker, `w${w}-${crypto.randomUUID()}`)))).flat();
      await Promise.all(dbs.map((db) => db.close()));
    } else {
      // SQLite: one connection per worker thread, released at the same instant.
      const start = new SharedArrayBuffer(4);
      const runs = Array.from({ length: workers }, (_, w) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(new URL('./claimWorker.js', import.meta.url), {
            workerData: { store, count: perWorker, prefix: `w${w}-${crypto.randomUUID()}`, start },
          });
          worker.on('message', resolve);
          worker.on('error', reject);
        }),
      );
      setTimeout(() => {
        Atomics.store(new Int32Array(start), 0, 1);
        Atomics.notify(new Int32Array(start), 0);
      }, 200);
      claimed = (await Promise.all(runs)).flat();
    }

    expect(claimed).toHaveLength(workers * perWorker);
    expect(new Set(claimed).size).toBe(claimed.length);

    const check = await openDatabase(store);
    const rows = await check.all('SELECT claimed_by FROM allocation_slots WHERE claimed_by IS NOT NULL');
    expect(rows).toHaveLength(workers * perWorker);
    // 120 claims on a 40-slot list means it was extended, in whole blocks, without gaps.
    const seqs = await check.all("SELECT seq_no FROM allocation_slots WHERE list = 'main' AND claimed_by IS NOT NULL ORDER BY seq_no");
    expect(seqs.map((r) => r.seq_no)).toEqual(Array.from({ length: workers * perWorker }, (_, i) => i + 1));
    await check.close();
  });
});
