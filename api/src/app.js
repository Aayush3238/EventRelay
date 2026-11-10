const express = require('express');
const helmet = require('helmet'); //security headers
const cors = require('cors');
const rateLimit = require('express-rate-limit'); //1000/min
const pinoHttp = require('pino-http'); //structured logs
const crypto = require('node:crypto'); //ids, signatures

const logger = require('./lib/logger');
const env = require('./config/env');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const apiKeyRoutes = require('./routes/apiKeys');
const endpointRoutes = require('./routes/endpoints');
const eventRoutes = require('./routes/events');
const deliveryRoutes = require('./routes/deliveries');
const statsRoutes = require('./routes/stats');

const app = express();

app.use(helmet());
// requestId: accept the caller's if they sent one (tracing), else mint one.
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  _res.setHeader('X-Request-Id', req.id);
  next();
});
app.use(pinoHttp({ logger, genReqId: (req) => req.id }));
app.use(cors({ origin: env.clientUrl }));
app.use(express.json({ limit: '1mb' }));

app.use(rateLimit({ windowMs: 60 * 1000, limit: 1000, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'eventrelay-api' }));

app.use('/auth', authRoutes);
app.use('/api-keys', apiKeyRoutes);
app.use('/endpoints', endpointRoutes);
app.use('/', eventRoutes); // includes POST /v1/events + GET /events
app.use('/deliveries', deliveryRoutes);
app.use('/stats', statsRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
