import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/db.js';
import { commentary } from '../db/schema.js';
import { matchIdParamSchema } from '../validation/matches.js';
import {
  createCommentarySchema,
  listCommentaryQuerySchema,
} from '../validation/commentary.js';

// Hard ceiling so a missing/malicious limit can never return unbounded rows
const MAX_LIMIT = 100;

// mergeParams: true makes /:matchId from the parent path available as req.params.matchId
const commentaryRouter = Router({ mergeParams: true });

// GET /matches/:matchId/commentary
commentaryRouter.get('/', async (req: any, res: any) => {
  const paramsParsed = matchIdParamSchema.safeParse({ id: req.params.matchId });
  if (!paramsParsed.success) {
    res.status(400).json({ error: 'Invalid match ID.', details: paramsParsed.error.flatten() });
    return;
  }

  const queryParsed = listCommentaryQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: 'Invalid query parameters.', details: queryParsed.error.flatten() });
    return;
  }

  const { id: matchId } = paramsParsed.data;
  const limit = Math.min(queryParsed.data.limit ?? MAX_LIMIT, MAX_LIMIT);

  try {
    const rows = await db
      .select()
      .from(commentary)
      .where(eq(commentary.matchId, matchId))
      .orderBy(desc(commentary.createdAt))
      .limit(limit);

    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch commentary.', details: JSON.stringify(e) });
  }
});

// POST /matches/:matchId/commentary
commentaryRouter.post('/', async (req: any, res: any) => {
  const paramsParsed = matchIdParamSchema.safeParse({ id: req.params.matchId });
  if (!paramsParsed.success) {
    res.status(400).json({ error: 'Invalid match ID.', details: paramsParsed.error.flatten() });
    return;
  }

  const bodyParsed = createCommentarySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: 'Validation failed.', details: bodyParsed.error.flatten() });
    return;
  }

  const { id: matchId } = paramsParsed.data;
  // Zod schema uses `minutes`; the DB column is `minute` (singular)
  const { minutes, ...rest } = bodyParsed.data;

  try {
    const [entry] = await db
      .insert(commentary)
      .values({ ...rest, minute: minutes, matchId })
      .returning();
    
    // broadcast commentary to websocket 
    if(res?.app?.locals?.broadCastCommentary){
      res.app.locals.broadCastCommentary(entry?.matchId, entry);
    }
    

    res.status(201).json({ data: entry });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create commentary.', details: JSON.stringify(e) });
  }
});

export default commentaryRouter;
