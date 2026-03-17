const https = require('https');

function sendPreSlaAlertEmail({ to, subject, text }) {
  return new Promise((resolve) => {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    const from = process.env.ALERT_EMAIL_FROM;
    const replyTo = process.env.ALERT_EMAIL_REPLY_TO;
    if (!token || !from || !to) {
      // eslint-disable-next-line no-console
      console.error('sendPreSlaAlertEmail: missing POSTMARK_SERVER_TOKEN, ALERT_EMAIL_FROM, or recipient');
      resolve();
      return;
    }
    const body = {
      From: from,
      To: to,
      Subject: subject,
      TextBody: text,
    };
    if (replyTo) {
      body.ReplyTo = replyTo;
    }
    const payload = JSON.stringify(body);
    const options = {
      method: 'POST',
      hostname: 'api.postmarkapp.com',
      path: '/email',
      headers: {
        'X-Postmark-Server-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        resolve();
      });
    });
    req.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('sendPreSlaAlertEmail: Postmark request failed', err.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendPreSlaAlertEmail };

