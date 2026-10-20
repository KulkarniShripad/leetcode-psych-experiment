import { Router } from 'express';
import { requireActive, requireParticipant } from '../middleware/auth.js';
import { parsePosition, schemas, validateBody } from '../middleware/validate.js';

export function questionRoutes({ study }) {
  const router = Router();
  const guard = [requireParticipant, requireActive];

  router.post('/api/instructions/ack', ...guard, async (req, res) => {
    await study.ackInstructions(req.participant);
    res.json({ ok: true, state: await study.publicState(req.participant) });
  });

  // Only the participant's current question. Sets shown_at the first time.
  router.get('/api/question/:n', ...guard, async (req, res) => {
    const participant = await study.applyExpiry(req.participant);
    res.json(await study.getQuestion(participant, parsePosition(req.params.n)));
  });

  router.post('/api/answer', ...guard, validateBody(schemas.answer), async (req, res) => {
    res.json(await study.submitAnswer(req.participant, req.valid));
  });

  // The Next button on the feedback screen (S4 -> next question or S5).
  router.post('/api/next', ...guard, validateBody(schemas.next), async (req, res) => {
    await study.ackFeedback(req.participant, req.valid.n);
    res.json({ ok: true, state: await study.publicState(req.participant) });
  });

  return router;
}
