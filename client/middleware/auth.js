const jwt = require('jsonwebtoken');

module.exports = pool => async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed token' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Missing or malformed token' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  if (typeof decoded.id !== 'string' || !decoded.id) {
    return res.status(401).json({ error: 'Invalid authenticated user' });
  }

  let currentVersion;
  try {
    const result = await pool.query(
      'SELECT session_version FROM users WHERE id = $1',
      [decoded.id]
    );
    currentVersion = result.rows[0]?.session_version;
  } catch {
    return res.status(500).json({ error: 'Authentication failed' });
  }

  const tokenVersion = decoded.session_version ?? 0;
  if (!Number.isInteger(currentVersion) || tokenVersion !== currentVersion) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded; // { id, household_id, email }
  return next();
};