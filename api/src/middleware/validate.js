// Zod validation as middleware: validate(schema) → (req,res,next).
// Returning 422 (not 400) for body validation keeps "bad shape" distinct
// from "bad request" in our error contract.
const { z } = require('zod');

function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) {
      const err = new Error('Validation failed');
      err.status = 422;
      err.code = 'VALIDATION_ERROR';
      err.details = parsed.error.flatten();
      return next(err);
    }
    req[source] = parsed.data;
    return next();
  };
}

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(120).default('default'),
  expiresAt: z.string().datetime().optional(),
});

const endpointSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url().max(2048),
  eventTypes: z.array(z.string().min(1).max(200)).max(100).default([]),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  maxAttempts: z.number().int().min(1).max(20).default(6),
  isActive: z.boolean().default(true),
});

const ingestSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._-]+$/, 'Invalid event type'),
    data: z.record(z.any()),
  })
  .strict();

module.exports = {
  validate,
  paginationSchema,
  registerSchema,
  loginSchema,
  createApiKeySchema,
  endpointSchema,
  ingestSchema,
};
