import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { validateBody } from '../middleware/validate.js';
import { EXPORTS, buildExport } from '../services/exporter.js';
import {
  backupDatabaseFile, dumpDatabase, purgePilotData, setStudyMode, studyStatus, withdrawParticipantData,
} from '../services/maintenance.js';
import { CODE_PATTERN, nowIso } from '../util.js';

export const PURGE_PHRASE = 'DELETE PILOT DATA';

export function adminRoutes({ db, content, config, startedAt }) {
  const router = Router();
  router.use('/admin/api', requireAdmin(config));

  router.get('/admin/api/status', async (req, res) => {
    res.json(await studyStatus(db, content, startedAt));
  });

  // participants.csv, questions.csv, surveys.csv, events.csv, gamification.csv, allocation.csv, meta.csv
  // Research data by default; ?cohort=pilot gives the pilot rows instead (for reviewing the pilot).
  router.get('/admin/api/export/:name.csv', async (req, res) => {
    const pilot = req.query.cohort === 'pilot';
    const csv = await buildExport(db, content, req.params.name, { pilot });
    if (csv === null) throw new AppError('NOT_FOUND', `Unknown export. Use one of: ${Object.keys(EXPORTS).join(', ')}.`);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${pilot ? 'PILOT_' : ''}${EXPORTS[req.params.name]}"`);
    res.send(csv);
  });

  // A full copy of every table, downloaded to the researcher's computer. Works for both
  // the local SQLite file and the cloud database.
  router.get('/admin/api/backup.json', async (req, res) => {
    const dump = await dumpDatabase(db);
    res.set('Content-Disposition', `attachment; filename="confidence-quest-backup-${dump.exported_at_utc.replace(/[:.]/g, '-')}.json"`);
    res.json(dump);
  });

  // SQLite only: a copy of the database file on the server's disk.
  router.post('/admin/api/backup', async (req, res) => {
    const file = await backupDatabaseFile(db, config.backupDir, 'admin');
    if (!file) throw new AppError('VALIDATION', 'The cloud database keeps its own history. Use "Download full backup" instead.');
    res.json({ ok: true, file: file.split(/[\\/]/).pop(), at: nowIso() });
  });

  router.post('/admin/api/mode', validateBody(z.object({ mode: z.enum(['pilot', 'live']) })), async (req, res) => {
    await setStudyMode(db, req.valid.mode);
    res.json({ ok: true, study_mode: req.valid.mode });
  });

  router.post(
    '/admin/api/purge-pilot',
    validateBody(z.object({ confirm: z.literal(PURGE_PHRASE) }), `Type "${PURGE_PHRASE}" to confirm.`),
    async (req, res) => {
      res.json({ ok: true, removed: await purgePilotData(db) });
    },
  );

  router.post(
    '/admin/api/withdraw',
    validateBody(z.object({ participant_code: z.string().regex(CODE_PATTERN), confirm: z.literal(true) }), 'Enter a valid 6-character code.'),
    async (req, res) => {
      if (!(await withdrawParticipantData(db, req.valid.participant_code))) throw new AppError('NOT_FOUND', 'No participant with that code.');
      res.json({ ok: true });
    },
  );

  return router;
}
