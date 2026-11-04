const express = require('express');
const router = express.Router();
const LedgerController = require('../models/ledger');
const authenticate = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

router.get('/', LedgerController.index);
router.get('/summary', LedgerController.summary);
router.post('/iou', LedgerController.createIOU);
router.patch('/:id/paid', LedgerController.markPaid);

module.exports = router;
