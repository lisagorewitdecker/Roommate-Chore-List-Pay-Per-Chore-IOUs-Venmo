const express = require('express');
const cors = require('cors');
const pool = require('./db.cjs');
const auth = require('./middleware/auth.js');
const { createAuthController } = require('./controllers/authController.cjs');
const { createPaymentController } = require('./controllers/paymentController.cjs');
const { createAiPricingController } = require('./controllers/aiPricingController.cjs');
const { createAiFairnessController } = require('./controllers/aiFairnessController.cjs');
const { createAiSuggestionsController } = require('./controllers/aiSuggestionsController.cjs');
const { createChoreController } = require('./controllers/choreController.cjs');
const { createSupplyController } = require('./controllers/supplyController.cjs');
const { createLedgerController } = require('./controllers/ledgerController.cjs');
const { createAuthRoutes } = require('./routes/authRoutes.cjs');

function createRateLimiter({ limit = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const requestsByIp = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let requestWindow = requestsByIp.get(ip);
    if (!requestWindow || requestWindow.resetAt <= now) {
      requestWindow = { count: 0, resetAt: now + windowMs };
      requestsByIp.set(ip, requestWindow);
    }

    requestWindow.count += 1;
    if (requestWindow.count > limit) {
      res.set('Retry-After', String(Math.ceil((requestWindow.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many password reset requests. Please try again later.' });
    }

    if (requestsByIp.size > 10000) {
      for (const [key, value] of requestsByIp) {
        if (value.resetAt <= now) requestsByIp.delete(key);
      }
    }
    return next();
  };
}

function createApp({
  pool: paymentPool = pool,
  aiClientFactory,
  sendPasswordResetEmail,
  passwordResetEmailConfigured
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    credentials: true
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use('/api/auth/password-reset', createRateLimiter());
  app.use('/api/auth', createAuthRoutes(createAuthController(paymentPool, {
    sendPasswordResetEmail,
    passwordResetEmailConfigured
  })));
  const choreController = createChoreController(paymentPool);
  app.get('/api/chores', auth, choreController.list);
  app.post('/api/chores', auth, choreController.create);
  app.patch('/api/chores/:id', auth, choreController.update);
  app.patch('/api/chores/:id/complete', auth, choreController.complete);
  app.post('/api/chores/:id/offer', auth, choreController.offer);
  app.post('/api/chores/:id/claim', auth, choreController.claim);
  app.delete('/api/chores/:id', auth, choreController.remove);
  const supplyController = createSupplyController(paymentPool);
  app.get('/api/supplies', auth, supplyController.list);
  app.post('/api/supplies', auth, supplyController.create);
  app.patch('/api/supplies/:id', auth, supplyController.update);
  app.post('/api/supplies/:id/purchase', auth, supplyController.purchase);
  app.post('/api/payments/pay-chore', auth, createPaymentController(paymentPool));
  const ledgerController = createLedgerController(paymentPool);
  app.get('/api/ledger', auth, ledgerController.list);
  app.get('/api/ledger/summary', auth, ledgerController.summary);
  app.patch('/api/ledger/venmo', auth, ledgerController.updateVenmo);
  app.post('/api/ledger/ious', auth, ledgerController.createIou);
  app.patch('/api/ledger/ious/:id/paid', auth, ledgerController.markPaid);
  app.post('/api/ai/estimate-price', auth, createAiPricingController(aiClientFactory));
  app.post('/api/ai/fair-split', auth, createAiFairnessController(paymentPool, aiClientFactory));
  app.post('/api/ai/suggest-chores', auth, createAiSuggestionsController(paymentPool, aiClientFactory));
  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(400).json({ error: 'Invalid request body' });
  });
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Payment API listening on port ${port}`);
  });
}

module.exports = { createApp };