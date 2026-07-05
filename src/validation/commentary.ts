import { z } from 'zod';

export const listCommentaryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
});

export const createCommentarySchema = z.object({
  minutes: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  period: z.string().min(1, 'period is required'),
  eventType: z.enum(['goal', 'assist', 'yellow_card', 'red_card', 'substitution', 'foul', 'offside', 'corner', 'penalty', 'other']),
  actor: z.string().min(1, 'actor is required'),
  team: z.string().min(1, 'team is required'),
  message: z.string().min(1, 'message is required'),
  metadata: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
});
