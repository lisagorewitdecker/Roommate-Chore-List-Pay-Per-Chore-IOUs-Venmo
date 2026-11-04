const express = require('express');
const router = express.Router();
const AuthController = require('../models/auth');
const authenticate = require('../middleware/auth');

// Public routes
router.post('/register', AuthController.register);
router.post('/login', AuthController.login);

// Protected routes
router.get('/me', authenticate, AuthController.me);

module.exports = router;
