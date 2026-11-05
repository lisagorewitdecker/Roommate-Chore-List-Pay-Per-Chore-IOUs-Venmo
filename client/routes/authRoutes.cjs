const express = require('express');
const { rateLimit } = require('express-rate-limit');
const authenticate = require('../middleware/auth');

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

function createRouteRateLimiter(error) {
  return rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    limit: RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error })
  });
}

function createAuthRoutes(controller) {
  const router = express.Router();
  const registerRateLimiter = createRouteRateLimiter('Too many registration attempts. Please try again later.');
  const loginRateLimiter = createRouteRateLimiter('Too many login attempts. Please try again later.');
  const passwordResetRateLimiter = createRouteRateLimiter('Too many password reset requests. Please try again later.');

  router.post('/register', registerRateLimiter, controller.register);
  router.post('/login', loginRateLimiter, controller.login);
  router.post('/password-reset/request', passwordResetRateLimiter, controller.requestPasswordReset);
  router.post('/password-reset/complete', passwordResetRateLimiter, controller.completePasswordReset);
  router.get('/me', authenticate, controller.getProfile);

  return router;
}

module.exports = { createAuthRoutes };