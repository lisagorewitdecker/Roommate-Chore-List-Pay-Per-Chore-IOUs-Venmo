const express = require('express');
const router = express.Router();
const ReminderController = require('../services/reminders');
const authenticate = require('../middleware/auth');

// All routes require authentication
router.use(authenticate);

router.get('/', ReminderController.index);
router.post('/', ReminderController.store);
router.post('/send-due', ReminderController.sendDueReminders);
router.get('/users', ReminderController.getUsers);

module.exports = router;
