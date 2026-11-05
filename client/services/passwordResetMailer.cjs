const nodemailer = require('nodemailer');

function getSmtpConfig() {
  return {
    host: process.env.SMTP_HOST?.trim(),
    port: Number(process.env.SMTP_PORT),
    user: process.env.SMTP_USER?.trim(),
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM?.trim(),
    secure: process.env.SMTP_SECURE === 'true'
  };
}

function isPasswordResetEmailConfigured() {
  const config = getSmtpConfig();
  return Boolean(config.host && Number.isInteger(config.port) && config.port > 0 && config.port <= 65535
    && config.user && config.password && config.from);
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  if (!isPasswordResetEmailConfigured()) {
    throw new Error('SMTP password reset settings are missing');
  }

  const config = getSmtpConfig();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure || config.port === 465,
    auth: { user: config.user, pass: config.password }
  });
  await transporter.sendMail({
    from: config.from,
    to,
    subject: 'Reset your password',
    text: `Use this link to reset your password. The link expires in one hour and can only be used once:\n\n${resetUrl}\n\nIf you did not request a password reset, you can ignore this email.`
  });
}

module.exports = { isPasswordResetEmailConfigured, sendPasswordResetEmail };