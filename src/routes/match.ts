import { Router } from 'express';
import { db } from '../db/db.js';
import { matches } from '../db/schema.js';
import { MATCH_STATUS, createMatchSchema } from '../validation/matches.js';

const matchRouter = Router();

function getMatchStatus(startTime: string, endTime: string): string {
  const now = new Date();
  if (now < new Date(startTime)) return MATCH_STATUS.SCHEDULED;
  if (now > new Date(endTime)) return MATCH_STATUS.FINISHED;
  return MATCH_STATUS.LIVE;
}

matchRouter.get('/', async (_req, res) => {
  try {
    const allMatches = await db.select().from(matches);
    res.json({ data: allMatches });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch matches.', details: JSON.stringify(e) });
  }
});

matchRouter.post('/', async (req, res) => {
  const parsed = createMatchSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed.', details: parsed.error.flatten() });
    return;
  }

  const { startTime, endTime, homeScore, awayScore } = parsed.data;

  try {
    const [event] = await db
      .insert(matches)
      .values({
        ...parsed.data,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        homeScore: homeScore ?? 0,
        awayScore: awayScore ?? 0,
        status: getMatchStatus(startTime, endTime),
      })
      .returning();

      if(res?.app?.locals?.broadCastCreateMatch){
        res?.app?.locals?.broadCastCreateMatch(event)
      }

    res.status(201).json({ data: event });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create match.', details: JSON.stringify(e) });
  }
});

export default matchRouter;
