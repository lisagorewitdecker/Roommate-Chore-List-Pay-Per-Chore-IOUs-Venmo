const bcrypt = require('bcrypt');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const {
  isPasswordResetEmailConfigured,
  sendPasswordResetEmail: deliverPasswordResetEmail
} = require('../services/passwordResetMailer.cjs');

const BCRYPT_SALT_ROUNDS = 12;
const JWT_EXPIRES_IN = '7d';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RESET_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';
const INVALID_PASSWORD_RESET_MESSAGE = 'Invalid or expired password reset link';

function generateToken(user) {
  return jwt.sign({
    id: user.id,
    email: user.email,
    household_id: user.household_id,
    session_version: user.session_version ?? 0
  }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function serializeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    household_id: user.household_id,
    balance_cents: user.balance_cents
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createAuthController(pool, {
  sendPasswordResetEmail = deliverPasswordResetEmail,
  passwordResetEmailConfigured = isPasswordResetEmailConfigured
} = {}) {
  async function register(req, res) {
    const body = req.body;
    if (!isObject(body) || typeof body.name !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const name = body.name.trim();
    const email = body.email.trim().toLowerCase();
    const password = body.password;
    const householdName = typeof body.household_name === 'string' ? body.household_name.trim() : '';
    const inviteCode = typeof body.invite_code === 'string' ? body.invite_code.trim().toUpperCase() : '';

    if (!name || name.length > 100) {
      return res.status(400).json({ error: 'Name must be between 1 and 100 characters' });
    }
    if (email.length > 255 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Password must not exceed 72 bytes' });
    }
    if (body.household_name !== undefined && typeof body.household_name !== 'string') {
      return res.status(400).json({ error: 'Household name must be text' });
    }
    if (householdName.length > 100) {
      return res.status(400).json({ error: 'Household name must not exceed 100 characters' });
    }
    if (body.invite_code !== undefined && typeof body.invite_code !== 'string') {
      return res.status(400).json({ error: 'Invite code must be text' });
    }
    if (inviteCode.length > 12) {
      return res.status(400).json({ error: 'Invite code is invalid' });
    }

    let client;
    let transactionStarted = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      transactionStarted = true;

      const existingUser = await client.query(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );
      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(409).json({ error: 'An account with this email already exists' });
      }

      let assignedHouseholdId;
      if (inviteCode) {
        const householdResult = await client.query(
          'SELECT id FROM households WHERE invite_code = $1',
          [inviteCode]
        );
        if (householdResult.rows.length === 0) {
          await client.query('ROLLBACK');
          transactionStarted = false;
          return res.status(404).json({ error: 'Invalid household invite code' });
        }
        assignedHouseholdId = householdResult.rows[0].id;
      } else {
        const invite = crypto.randomBytes(6).toString('hex').toUpperCase();
        const title = householdName || `${name}'s Apartment`.slice(0, 100);
        const householdResult = await client.query(
          'INSERT INTO households (name, invite_code) VALUES ($1, $2) RETURNING id',
          [title, invite]
        );
        assignedHouseholdId = householdResult.rows[0].id;
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      const userResult = await client.query(
        `INSERT INTO users (name, email, password_hash, household_id, balance_cents)
         VALUES ($1, $2, $3, $4, 0)
         RETURNING id, name, email, household_id, balance_cents, session_version, created_at`,
        [name, email, passwordHash, assignedHouseholdId]
      );

      const user = userResult.rows[0];
      const token = generateToken(user);
      await client.query('COMMIT');
      transactionStarted = false;

      return res.status(201).json({
        message: 'User registered successfully',
        token,
        user: serializeUser(user)
      });
    } catch (error) {
      let rollbackFailed = false;
      if (client && transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch {
          rollbackFailed = true;
        }
      }

      if (!rollbackFailed && error.code === '23505' && ['users_email_lower_idx', 'users_email_key'].includes(error.constraint)) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      console.error('Registration transaction failure:', error);
      return res.status(500).json({ error: 'Registration failed due to an internal server error' });
    } finally {
      if (client) client.release();
    }
  }

  async function login(req, res) {
    const body = req.body;
    if (!isObject(body) || typeof body.email !== 'string' || typeof body.password !== 'string' || !body.email.trim() || !body.password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const email = body.email.trim().toLowerCase();
    if (email.length > 255 || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    if (Buffer.byteLength(body.password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Password must not exceed 72 bytes' });
    }

    try {
      const result = await pool.query(
        `SELECT id, name, email, password_hash, household_id, balance_cents, session_version
         FROM users
         WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = generateToken(user);
      return res.status(200).json({
        message: 'Authentication successful',
        token,
        user: serializeUser(user)
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Internal server error during authentication' });
    }
  }

  async function requestPasswordReset(req, res) {
    const body = req.body;
    if (!isObject(body) || typeof body.email !== 'string' || !body.email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const email = body.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email) || email.length > 255) {
      return res.status(400).json({ error: 'Please provide a valid email address' });
    }
    if (!passwordResetEmailConfigured()) {
      return res.status(503).json({
        error: 'Password reset email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and SMTP_FROM.'
      });
    }

    try {
      const result = await pool.query(
        'SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );
      const user = result.rows[0];
      if (user) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await pool.query(
          `UPDATE users
           SET password_reset_token_hash = $1,
               password_reset_token_expires_at = NOW() + INTERVAL '1 hour'
           WHERE id = $2`,
          [tokenHash, user.id]
        );

        const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
        const resetUrl = new URL('/reset-password', `${clientOrigin.replace(/\/$/, '')}/`);
        resetUrl.searchParams.set('token', token);
        try {
          void Promise.resolve(sendPasswordResetEmail({ to: user.email, resetUrl: resetUrl.toString() }))
            .catch(error => console.error('Password reset email delivery failed:', error));
        } catch (error) {
          console.error('Password reset email delivery failed:', error);
        }
      }

      return res.status(200).json({ message: PASSWORD_RESET_MESSAGE });
    } catch (error) {
      console.error('Password reset request failed:', error);
      return res.status(500).json({ error: 'Unable to send password reset email. Please try again later.' });
    }
  }

  async function completePasswordReset(req, res) {
    const body = req.body;
    if (!isObject(body) || typeof body.token !== 'string' || typeof body.password !== 'string') {
      return res.status(400).json({ error: 'A reset token and new password are required' });
    }
    if (body.password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    if (Buffer.byteLength(body.password, 'utf8') > 72) {
      return res.status(400).json({ error: 'Password must not exceed 72 bytes' });
    }
    if (!/^[a-f0-9]{64}$/.test(body.token)) {
      return res.status(400).json({ error: INVALID_PASSWORD_RESET_MESSAGE });
    }

    try {
      const tokenHash = crypto.createHash('sha256').update(body.token).digest('hex');
      const passwordHash = await bcrypt.hash(body.password, BCRYPT_SALT_ROUNDS);
      const result = await pool.query(
        `UPDATE users
         SET password_hash = $1,
             password_reset_token_hash = NULL,
             password_reset_token_expires_at = NULL,
             session_version = session_version + 1
         WHERE password_reset_token_hash = $2
           AND password_reset_token_expires_at > NOW()
         RETURNING id`,
        [passwordHash, tokenHash]
      );
      if (result.rows.length === 0) {
        return res.status(400).json({ error: INVALID_PASSWORD_RESET_MESSAGE });
      }

      return res.status(200).json({ message: 'Password has been reset. You can now sign in.' });
    } catch (error) {
      console.error('Password reset completion failed:', error);
      return res.status(500).json({ error: 'Password reset failed due to an internal server error' });
    }
  }

  async function getProfile(req, res) {
    if (typeof req.user?.id !== 'string' || !req.user.id) {
      return res.status(401).json({ error: 'Invalid authenticated user' });
    }

    try {
      const result = await pool.query(
        `SELECT
           u.id,
           u.name,
           u.email,
           u.balance_cents,
           u.household_id,
           h.name AS household_name,
           h.invite_code AS household_invite_code
         FROM users u
         LEFT JOIN households h ON u.household_id = h.id
         WHERE u.id = $1`,
        [req.user.id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User profile not found' });
      }

      const profile = result.rows[0];
      return res.status(200).json({
        user: {
          id: profile.id,
          name: profile.name,
          email: profile.email,
          balance_cents: profile.balance_cents,
          formatted_balance: `$${(profile.balance_cents / 100).toFixed(2)}`,
          household: {
            id: profile.household_id,
            name: profile.household_name,
            invite_code: profile.household_invite_code
          }
        }
      });
    } catch (error) {
      console.error('Profile fetch error:', error);
      return res.status(500).json({ error: 'Failed to retrieve profile' });
    }
  }

  return { register, login, requestPasswordReset, completePasswordReset, getProfile };
}

module.exports = { createAuthController };