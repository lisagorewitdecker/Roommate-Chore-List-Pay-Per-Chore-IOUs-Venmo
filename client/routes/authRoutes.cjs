const express = require('express');
const authenticate = require('../middleware/auth');

function createAuthRoutes(controller) {
  const router = express.Router();

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.post('/password-reset/request', controller.requestPasswordReset);
  router.post('/password-reset/complete', controller.completePasswordReset);
  router.get('/me', authenticate, controller.getProfile);

  return router;
}

module.exports = { createAuthRoutes };