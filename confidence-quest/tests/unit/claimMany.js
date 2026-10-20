import { claimSlot } from '../../server/services/assignment.js';

// Claims `count` slots one after another, each in its own transaction, as fast as possible.
export async function claimMany(db, count, prefix) {
  const claimed = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    claimed.push(
      await db.transaction(async () => {
        await db.run(
          `INSERT INTO participants (id, participant_code, token_hash, consent_at, consent_version, current_step, started_at)
           VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', 'test', 'PRE_SURVEY', '2026-01-01T00:00:00.000Z')`,
          [id, id.slice(-14), id],
        );
        return (await claimSlot(db, id, 'main')).id;
      }),
    );
  }
  return claimed;
}
