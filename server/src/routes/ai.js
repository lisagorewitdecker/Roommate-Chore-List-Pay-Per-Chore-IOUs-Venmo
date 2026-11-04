const express = require('express');
const router = express.Router();
const AIController = require('../services/ai');
const authenticate = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

router.post('/suggest-chores', AIController.suggestChores);
router.post('/fair-split', AIController.fairSplit);

module.exports = router;
