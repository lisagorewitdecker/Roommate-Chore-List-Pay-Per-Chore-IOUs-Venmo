const express = require('express');
const router = express.Router();
const ChoreController = require('../models/chores');
const authenticate = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

router.get('/', ChoreController.index);
router.get('/:id', ChoreController.show);
router.post('/', ChoreController.store);
router.put('/:id', ChoreController.update);
router.patch('/:id/complete', ChoreController.complete);
router.delete('/:id', ChoreController.destroy);

module.exports = router;
