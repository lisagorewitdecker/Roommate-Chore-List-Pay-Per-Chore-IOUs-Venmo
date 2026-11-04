const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/database');

const AuthController = {
  // Register a new user
  async register(req, res) {
    try {
      const { name, email, password } = req.body;

      if (!name || !email || !password) {
        return res.status(400).json({ error: 'Name, email, and password are required.' });
      }

      const existing = await db('users').where({ email }).first();
      if (existing) {
        return res.status(409).json({ error: 'Email already registered.' });
      }

      const password_hash = await bcrypt.hash(password, 10);
      const [user] = await db('users')
        .insert({ name, email, password_hash })
        .returning(['id', 'name', 'email', 'created_at']);

      const token = jwt.sign(
        { id: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      res.status(201).json({ user, token });
    } catch (err) {
      console.error('Register error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Login and return JWT
  async login(req, res) {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
      }

      const user = await db('users').where({ email }).first();
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const token = jwt.sign(
        { id: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      res.json({
        user: { id: user.id, name: user.name, email: user.email },
        token
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  },

  // Get current user profile
  async me(req, res) {
    try {
      const user = await db('users')
        .select('id', 'name', 'email', 'avatar_url', 'created_at')
        .where({ id: req.user.id })
        .first();

      if (!user) {
        return res.status(404).json({ error: 'User not found.' });
      }

      res.json({ user });
    } catch (err) {
      console.error('Me error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  }
};

module.exports = AuthController;
