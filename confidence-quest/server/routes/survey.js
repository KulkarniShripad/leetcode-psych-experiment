import { Router } from 'express';
import { requireActive, requireParticipant } from '../middleware/auth.js';
import { parsePhase, schemas, validateBody } from '../middleware/validate.js';

export function surveyRoutes({ study }) {
  const router = Router();

  router.get('/api/survey/:phase', requireParticipant, requireActive, async (req, res) => {
    res.json(await study.getSurvey(req.participant, parsePhase(req.params.phase)));
  });

  // Submits every answer at once. pre also assigns the arm; post_a (Q10) leads to the score.
  router.post(
    '/api/survey/:phase',
    requireParticipant,
    requireActive,
    validateBody(schemas.surveySubmit, 'Please answer every question before continuing.'),
    async (req, res) => {
      const phase = parsePhase(req.params.phase);
      const result = await study.submitSurvey(req.participant, phase, req.valid.answers);
      res.json({ ok: true, already_submitted: result.already_submitted, state: await study.publicState(req.participant) });
    },
  );

  return router;
}
