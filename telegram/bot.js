/**
 * Hermes Telegram bot — capture messages as notes; /thread, /reply, /star, /tags.
 * Set TELEGRAM_BOT_TOKEN, HERMES_API_URL (e.g. https://host/hermes), HERMES_MCP_TOKEN (JWT).
 */
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiUrl = (process.env.HERMES_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const authToken = process.env.HERMES_MCP_TOKEN || process.env.HERMES_API_TOKEN || '';

if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

function api(path, options = {}) {
  const url = `${apiUrl}/api${path}`;
  const headers = { ...options.headers, 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(url, { ...options, headers }).then((r) => (r.status === 204 ? {} : r.json()));
}

const userState = new Map();

bot.on('message', async (msg) => {
  const text = msg.text?.trim() || '';
  const chatId = msg.chat.id;
  if (!text) return;

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ').trim();
    if (cmd === '/thread') {
      try {
        const note = await api('/notes', { method: 'POST', body: JSON.stringify({ content: arg || 'New thread' }) });
        userState.set(chatId, { lastRootId: note.id, lastNoteId: note.id });
        bot.sendMessage(chatId, `Created thread. Note ID: ${note.id}`);
      } catch (e) {
        bot.sendMessage(chatId, `Error: ${e.message}`);
      }
      return;
    }
    if (cmd === '/reply' && arg) {
      try {
        const note = await api('/notes', { method: 'POST', body: JSON.stringify({ content: rest.slice(1).join(' ') || '—', parent_id: arg }) });
        userState.set(chatId, { ...userState.get(chatId), lastNoteId: note.id });
        bot.sendMessage(chatId, `Replied. Note ID: ${note.id}`);
      } catch (e) {
        bot.sendMessage(chatId, `Error: ${e.message}`);
      }
      return;
    }
    if (cmd === '/star') {
      const s = userState.get(chatId);
      if (!s?.lastNoteId) { bot.sendMessage(chatId, 'No last note. Send a message or /reply first.'); return; }
      try {
        await api(`/notes/${s.lastNoteId}/star`, { method: 'POST' });
        bot.sendMessage(chatId, 'Starred.');
      } catch (e) {
        bot.sendMessage(chatId, `Error: ${e.message}`);
      }
      return;
    }
    if (cmd === '/tags') {
      try {
        bot.sendMessage(
          chatId,
          'Tag suggestions: open the Hermes web app, open a thread, and hover any reply — suggestions appear in the side margins.'
        );
      } catch (e) {
        bot.sendMessage(chatId, `Error: ${e.message}`);
      }
      return;
    }
    return;
  }

  try {
    const note = await api('/notes', { method: 'POST', body: JSON.stringify({ content: text }) });
    userState.set(chatId, { lastRootId: note.id, lastNoteId: note.id });
    bot.sendMessage(chatId, `Saved as new note. ID: ${note.id}`);
  } catch (e) {
    bot.sendMessage(chatId, `Error: ${e.message}`);
  }
});

console.log('Hermes Telegram bot running. Send a message to create a root note.');
