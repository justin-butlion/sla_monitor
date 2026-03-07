const db = require('./db');
const sla = require('./sla');
const views = require('./views');

function parseSlaHours(value) {
  const n = parseInt(String(value).trim(), 10);
  if (Number.isNaN(n) || n < 1 || n !== Math.floor(n)) return null;
  return n;
}

function registerEventHandlers(app) {
  app.event('app_home_opened', async ({ event, client, context }) => {
    const userId = event.user;
    const teamId = context.teamId;
    const blocks = await views.buildHomeBlocks(client, teamId);
    await client.views.publish({
      user_id: userId,
      view: {
        type: 'home',
        blocks,
      },
    });
  });

  app.message(async ({ message, client, context }) => {
    const teamId = context.teamId;
    if (message.bot_id) {
      const config = await db.getConfigForChannelAtTime(teamId, message.channel, message.ts);
      if (!config || !config.include_bot_messages) return;
    }
    const subtype = message.subtype || '';
    if (subtype && subtype !== 'thread_broadcast') return;
    const channelId = message.channel;
    const hasThread = !!message.thread_ts;

    if (hasThread) {
      await sla.maybeMarkReplied(client, teamId, channelId, message.thread_ts, message.user);
      return;
    }

    await sla.maybeRecordPendingMessage(client, teamId, message);
  });

  app.action('add_channel', async ({ body, client, ack }) => {
    await ack();
    await client.views.open({
      trigger_id: body.trigger_id,
      view: views.addChannelModal(),
    });
  });

  app.action('edit_sla', async ({ body, client, ack }) => {
    await ack();
    const teamId = body.team?.id;
    const channelId = body.actions[0].value;
    const configs = await db.getCurrentChannelConfigs(teamId);
    const current = configs.find((c) => c.channel_id === channelId);
    const currentSla = current ? current.sla_hours : 12;
    const includeBotMessages = current ? !!current.include_bot_messages : false;
    let channelName = null;
    try {
      const r = await client.conversations.info({ channel: channelId });
      channelName = r.channel?.name || null;
    } catch {
      // keep channelName null, modal will show channel_id
    }
    await client.views.open({
      trigger_id: body.trigger_id,
      view: views.editSlaModal(channelId, channelName, currentSla, includeBotMessages),
    });
  });

  app.action('invite_app_to_channel', async ({ body, client, ack }) => {
    await ack();
    const channelId = body.actions[0].value;
    const teamId = body.team?.id;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: views.inviteAppToChannelModal(channelId, teamId),
    });
  });

  app.action('remove_channel', async ({ body, client, ack }) => {
    await ack();
    const channelId = body.actions[0].value;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: views.removeChannelConfirmModal(channelId),
    });
  });

  app.action('copy_failed_link', async ({ body, client, ack }) => {
    await ack();
    const teamId = body.team?.id;
    const failedId = body.actions[0].value;
    const failed = await db.getFailedMessageById(teamId, parseInt(failedId, 10));
    if (!failed) {
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          title: { type: 'plain_text', text: 'Not found' },
          close: { type: 'plain_text', text: 'Close' },
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Message no longer in the list.' } }],
        },
      }).catch(() => {});
      return;
    }
    const permalink = await client.chat.getPermalink({
      channel: failed.channel_id,
      message_ts: failed.message_ts,
    });
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        title: { type: 'plain_text', text: 'Message link' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `Copy this link:\n<${permalink.permalink}|Open message>`,
            },
          },
        ],
      },
    });
  });

  app.action('remove_failed', async ({ body, client, ack }) => {
    await ack();
    const failedId = body.actions[0].value;
    await client.views.open({
      trigger_id: body.trigger_id,
      view: views.removeFailedConfirmModal(failedId),
    });
  });

  app.view('add_channel_modal', async ({ view, client, body, ack }) => {
    const teamId = body.team?.id;
    const channelBlock = view.state.values.channel_block?.channel_select;
    const channelId = channelBlock?.selected_conversation || channelBlock?.value;
    const slaRaw = view.state.values.sla_block?.sla_input?.value;
    const slaHours = parseSlaHours(slaRaw);
    const botSelected = view.state.values.bot_block?.include_bots?.selected_options || [];
    const includeBotMessages = botSelected.some((o) => o.value === 'include');
    if (!channelId) {
      await ack({ response_action: 'errors', errors: { channel_block: 'Please select a channel.' } });
      return;
    }
    if (slaHours === null) {
      await ack({ response_action: 'errors', errors: { sla_block: 'Enter a whole number 1 or greater.' } });
      return;
    }
    const existing = await db.getCurrentChannelConfigs(teamId);
    if (existing.some((c) => c.channel_id === channelId)) {
      await ack({ response_action: 'errors', errors: { channel_block: 'This channel is already being monitored. Choose a different channel.' } });
      return;
    }
    let channelName = null;
    try {
      const r = await client.conversations.info({ channel: channelId });
      channelName = r.channel?.name || null;
    } catch {
      // store without name; display will use ID or resolve later
    }
    try {
      await db.addChannelConfig(teamId, channelId, slaHours, channelName, includeBotMessages);
    } catch (err) {
      console.error('add_channel_modal: addChannelConfig failed', err);
      await ack({ response_action: 'errors', errors: { channel_block: 'Could not save. Please try again.' } });
      return;
    }
    await ack();
    const userId = body.user?.id || body.user_id;
    if (!userId || !teamId) {
      console.error('add_channel_modal: no user or team id in body', JSON.stringify(Object.keys(body)));
      return;
    }
    try {
      const blocks = await views.buildHomeBlocks(client, teamId);
      await client.views.publish({
        user_id: userId,
        view: { type: 'home', blocks },
      });
      const configCount = (await db.getCurrentChannelConfigs(teamId)).length;
      console.log('add_channel_modal: published home tab for user', userId, 'channels count', configCount);
    } catch (err) {
      console.error('add_channel_modal: buildHomeBlocks or views.publish failed', err);
    }
  });

  app.view('edit_sla_modal', async ({ view, client, body, ack }) => {
    const teamId = body.team?.id;
    const channelId = view.private_metadata;
    const slaRaw = view.state.values.sla_block?.sla_input?.value;
    const slaHours = parseSlaHours(slaRaw);
    const botSelected = view.state.values.bot_block?.include_bots?.selected_options || [];
    const includeBotMessages = botSelected.some((o) => o.value === 'include');
    if (slaHours === null) {
      await ack({ response_action: 'errors', errors: { sla_block: 'Enter a whole number 1 or greater.' } });
      return;
    }
    await ack();
    const configs = await db.getCurrentChannelConfigs(teamId);
    const current = configs.find((c) => c.channel_id === channelId);
    const channelName = current?.channel_name || null;
    await db.addChannelConfigRow(teamId, channelId, slaHours, channelName, includeBotMessages);
    const userId = body.user.id;
    const blocks = await views.buildHomeBlocks(client, teamId);
    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks },
    });
  });

  app.view('remove_channel_confirm_modal', async ({ view, client, body, ack }) => {
    await ack();
    const teamId = body.team?.id;
    const channelId = view.private_metadata;
    await db.removeChannel(teamId, channelId);
    const userId = body.user.id;
    const blocks = await views.buildHomeBlocks(client, teamId);
    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks },
    });
  });

  app.view('remove_failed_confirm_modal', async ({ view, client, body, ack }) => {
    await ack();
    const teamId = body.team?.id;
    const failedId = view.private_metadata;
    await db.removeFailedMessage(teamId, parseInt(failedId, 10));
    const userId = body.user.id;
    const blocks = await views.buildHomeBlocks(client, teamId);
    await client.views.publish({
      user_id: userId,
      view: { type: 'home', blocks },
    });
  });
}

module.exports = { registerEventHandlers, parseSlaHours };
