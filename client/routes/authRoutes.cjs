const express = require('express');
const authenticate = require('../middleware/auth');

function createAuthRoutes(controller) {
  const router = express.Router();

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.get('/me', authenticate, controller.getProfile);

  return router;
}

module.exports = { createAuthRoutes };