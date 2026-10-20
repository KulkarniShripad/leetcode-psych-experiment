import { Router } from 'express';
import { requireActive, requireParticipant } from '../middleware/auth.js';

export function resultRoutes({ study }) {
  const router = Router();

  // S5: the score reveal (same score sentence for both groups; game results for experimental).
  router.get('/api/results', requireParticipant, requireActive, async (req, res) => {
    res.json(await study.getResults(req.participant));
  });

  router.post('/api/results/ack', requireParticipant, requireActive, async (req, res) => {
    await study.ackResults(req.participant);
    res.json({ ok: true, state: await study.publicState(req.participant) });
  });

  return router;
}
