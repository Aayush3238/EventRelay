// Error contract: { error: { code, message, requestId, details? } }
// requestId is the same id we log with, so a user report maps to a log line.
function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  const requestId = req.id || req.headers['x-request-id'] || 'unknown';
  if (status >= 500) req.log?.error({ err }, 'request failed');
  res.status(status).json({
    error: {
      code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
      message: status >= 500 ? 'Internal server error' : err.message,
      requestId,
      ...(err.details ? { details: err.details } : {}),
    },
  });
}

function notFound(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}`, requestId: req.id },
  });
}

module.exports = { errorHandler, notFound };
