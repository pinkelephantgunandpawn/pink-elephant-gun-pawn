// Explicit, one-shot SMTP verification. Run only when an operator chooses to.
// Never imports the storefront, database, orders, or supplier integrations.
import nodemailer from 'nodemailer';

const recipient = process.env.SMTP_TEST_TO?.trim();
if (recipient !== 'bkmaxth5@gmail.com') {
  console.error('Refusing to send: SMTP_TEST_TO must be the approved test inbox.');
  process.exit(2);
}
for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) {
  if (!process.env[key]) {
    console.error('Missing SMTP setting:', key);
    process.exit(2);
  }
}
const port = Number(process.env.SMTP_PORT || 587);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid SMTP_PORT');
  process.exit(2);
}
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 15000,
});
try {
  const result = await transport.sendMail({
    from: process.env.ORDER_FROM_EMAIL || process.env.SMTP_USER,
    to: recipient,
    subject: 'Pink Elephant - one-time SMTP upgrade test',
    text: 'This is a single test message to verify the Nodemailer upgrade. No customer order was created.',
  });
  console.log('One test email accepted by SMTP server:', Boolean(result.accepted?.includes(recipient)));
} catch (error) {
  console.error('SMTP test failed:', error.code || error.name || 'unknown');
  process.exitCode = 1;
} finally {
  transport.close();
}
