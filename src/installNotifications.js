const webhookUrl = process.env.INSTALL_NOTIFICATIONS_WEBHOOK_URL;

async function notifyInstallationEvent({
  eventType,
  teamId,
  workspaceName,
  installerUserId,
  installerEmail,
}) {
  if (!webhookUrl) return false;

  const nowIso = new Date().toISOString();
  const eventLabel = eventType === 'reinstalled' ? 'Reinstalled' : 'Installed';
  const workspaceLabel = workspaceName || '(unknown workspace name)';
  const installerLabel = installerUserId ? `<@${installerUserId}>` : '(unknown installer)';
  const emailLabel = installerEmail || '(email unavailable)';

  const payload = {
    text: `SLA Monitor ${eventLabel}: ${workspaceLabel} (${teamId})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `SLA Monitor ${eventLabel}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Workspace:*\n${workspaceLabel}` },
          { type: 'mrkdwn', text: `*Team ID:*\n${teamId}` },
          { type: 'mrkdwn', text: `*Installer:*\n${installerLabel}` },
          { type: 'mrkdwn', text: `*Installer Email:*\n${emailLabel}` },
          { type: 'mrkdwn', text: `*Event:*\n${eventType}` },
          { type: 'mrkdwn', text: `*Timestamp:*\n${nowIso}` },
        ],
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Webhook returned ${response.status}: ${body}`);
    }
    return true;
  } catch (err) {
    console.warn(`Install notification webhook failed: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { notifyInstallationEvent };
