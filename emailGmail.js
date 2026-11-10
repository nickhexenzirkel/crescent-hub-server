const crypto = require('crypto');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_KEY_PREFIX = 'gmail_oauth_user_';
const oauthStates = new Map();
const refreshes = new Map();

function configurationReady() {
  return Boolean(
    process.env.GMAIL_GOOGLE_CLIENT_ID
    && process.env.GMAIL_GOOGLE_CLIENT_SECRET
    && process.env.GMAIL_GOOGLE_REDIRECT_URI
    && /^[a-f\d]{64}$/i.test(process.env.GMAIL_TOKEN_ENCRYPTION_KEY || ''),
  );
}

function getEncryptionKey() {
  const value = process.env.GMAIL_TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('A chave de criptografia do Gmail não está configurada corretamente.');
  return Buffer.from(value, 'hex');
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decrypt(value) {
  const stored = JSON.parse(value);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(stored.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(stored.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

function tokenKey(userId) {
  return `${TOKEN_KEY_PREFIX}${String(userId)}`;
}

async function loadAccount(supabase, userId) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', tokenKey(userId))
    .maybeSingle();
  if (error) throw error;
  return data?.value ? decrypt(data.value) : null;
}

async function saveAccount(supabase, userId, account) {
  const { error } = await supabase
    .from('settings')
    .upsert({ key: tokenKey(userId), value: encrypt(account) });
  if (error) throw error;
}

class GoogleError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function postGoogleForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GoogleError(data.error_description || data.error || 'O Google recusou a solicitação.', response.status);
  }
  return data;
}

async function googleJson(accessToken, path) {
  const response = await fetch(`${GMAIL_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GoogleError(data.error?.message || 'Não foi possível consultar o Gmail.', response.status);
  }
  return data;
}

async function accessToken(supabase, userId, forceRefresh = false) {
  const account = await loadAccount(supabase, userId);
  if (!account?.refresh_token) {
    throw new GoogleError('Conecte uma conta Gmail para continuar.', 401);
  }
  if (!forceRefresh && account.expiry_date > Date.now() + 60_000 && account.access_token) {
    return { account, token: account.access_token };
  }
  const key = String(userId);
  let refresh = refreshes.get(key);
  if (!refresh) {
    refresh = (async () => {
      const refreshed = await postGoogleForm(GOOGLE_TOKEN_URL, {
        client_id: process.env.GMAIL_GOOGLE_CLIENT_ID,
        client_secret: process.env.GMAIL_GOOGLE_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type: 'refresh_token',
      });
      const updated = {
        ...account,
        ...refreshed,
        refresh_token: refreshed.refresh_token || account.refresh_token,
        expiry_date: Date.now() + (Number(refreshed.expires_in) || 3600) * 1000,
      };
      await saveAccount(supabase, userId, updated);
      return { account: updated, token: updated.access_token };
    })();
    refreshes.set(key, refresh);
  }
  try {
    return await refresh;
  } finally {
    if (refreshes.get(key) === refresh) refreshes.delete(key);
  }
}

async function gmailJson(supabase, userId, path) {
  let credentials = await accessToken(supabase, userId);
  try {
    return await googleJson(credentials.token, path);
  } catch (error) {
    if (error.status !== 401) throw error;
    credentials = await accessToken(supabase, userId, true);
    return googleJson(credentials.token, path);
  }
}

function headerMap(payload) {
  const headers = payload?.headers || [];
  return Object.fromEntries(headers.map(header => [header.name.toLowerCase(), header.value]));
}

function decodeBody(data) {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function walkParts(part, result) {
  if (!part) return;
  const mimeType = String(part.mimeType || '').toLowerCase();
  if (part.body?.data && mimeType === 'text/plain' && !result.text) result.text = decodeBody(part.body.data);
  if (part.body?.data && mimeType === 'text/html' && !result.html) result.html = decodeBody(part.body.data);
  if (part.filename && part.body?.attachmentId) {
    result.attachments.push({
      id: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType || 'application/octet-stream',
      size: Number(part.body.size) || 0,
    });
  }
  for (const child of part.parts || []) walkParts(child, result);
}

function metadata(message) {
  const headers = headerMap(message.payload);
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet || '',
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    date: headers.date || '',
  };
}

function routeError(res, label, error) {
  const status = error instanceof GoogleError && error.status >= 400 && error.status < 500
    ? error.status
    : 502;
  console.error(`[Gmail] ${label}:`, error.message);
  res.status(status).json({
    error: status === 401
      ? 'A autorização do Gmail não está ativa. Conecte a conta novamente.'
      : error.message || 'Falha ao consultar o Gmail.',
  });
}

module.exports = function registerEmailRoutes(app, { supabase, requireAdmin }) {
  app.use('/api/email', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  });

  app.get('/api/email/status', requireAdmin, async (req, res) => {
    try {
      if (!configurationReady()) return res.json({ configured: false, connected: false });
      const account = await loadAccount(supabase, req.user.id);
      res.json({
        configured: true,
        connected: Boolean(account?.refresh_token && account.email),
        email: account?.email || '',
      });
    } catch (error) {
      routeError(res, 'status', error);
    }
  });

  app.post('/api/email/oauth/start', requireAdmin, (req, res) => {
    if (!configurationReady()) {
      return res.status(503).json({ error: 'A integração Gmail precisa ser configurada no servidor.' });
    }
    const now = Date.now();
    for (const [state, entry] of oauthStates) {
      if (entry.expiresAt <= now) oauthStates.delete(state);
    }
    const state = crypto.randomBytes(32).toString('hex');
    oauthStates.set(state, { userId: req.user.id, expiresAt: now + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: process.env.GMAIL_GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GMAIL_GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });

  app.get('/api/email/oauth/callback', async (req, res) => {
    const entry = oauthStates.get(String(req.query.state || ''));
    if (!entry || entry.expiresAt <= Date.now()) {
      oauthStates.delete(String(req.query.state || ''));
      return res.status(400).type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body style="font:16px sans-serif;text-align:center;padding:48px"><p>Conexão expirada ou inválida. Tente novamente pelo Uniko.</p><script>setTimeout(()=>window.close(),3500)</script></body></html>');
    }
    oauthStates.delete(String(req.query.state));
    if (req.query.error) {
      return res.status(400).type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body style="font:16px sans-serif;text-align:center;padding:48px"><p>A autorização do Gmail foi cancelada.</p><script>setTimeout(()=>window.close(),3500)</script></body></html>');
    }
    if (!req.query.code) {
      return res.status(400).type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body style="font:16px sans-serif;text-align:center;padding:48px"><p>O Google não retornou o código de autorização.</p><script>setTimeout(()=>window.close(),3500)</script></body></html>');
    }
    if (!configurationReady()) {
      return res.status(503).type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body style="font:16px sans-serif;text-align:center;padding:48px"><p>A integração Gmail não está configurada no servidor.</p><script>setTimeout(()=>window.close(),3500)</script></body></html>');
    }

    try {
      const tokens = await postGoogleForm(GOOGLE_TOKEN_URL, {
        code: String(req.query.code),
        client_id: process.env.GMAIL_GOOGLE_CLIENT_ID,
        client_secret: process.env.GMAIL_GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GMAIL_GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      });
      if (!tokens.refresh_token) throw new Error('O Google não forneceu um token de renovação. Tente conectar novamente.');
      const expiresIn = Number(tokens.expires_in) || 3600;
      const profile = await googleJson(tokens.access_token, '/profile');
      await saveAccount(supabase, entry.userId, {
        ...tokens,
        expiry_date: Date.now() + expiresIn * 1000,
        email: profile.emailAddress || '',
      });
      res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Gmail conectado</title><body style="font:16px sans-serif;text-align:center;padding:48px;color:#234"><h2>Gmail conectado ao Uniko</h2><p>Você já pode voltar ao módulo E-mail.</p><script>setTimeout(()=>window.close(),700)</script></body></html>');
    } catch (error) {
      console.error('[Gmail] OAuth callback:', error.message);
      res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Falha na conexão</title><body style="font:16px sans-serif;text-align:center;padding:48px;color:#234"><h2>Não foi possível conectar o Gmail</h2><p>Feche esta janela e tente novamente pelo Uniko.</p><script>setTimeout(()=>window.close(),3500)</script></body></html>');
    }
  });

  app.delete('/api/email/disconnect', requireAdmin, async (req, res) => {
    try {
      const { error } = await supabase.from('settings').delete().eq('key', tokenKey(req.user.id));
      if (error) return routeError(res, 'desconectar conta', error);
      res.json({ ok: true });
    } catch (error) {
      routeError(res, 'desconectar conta', error);
    }
  });

  app.get('/api/email/messages', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || 'in:inbox').slice(0, 300);
      const params = new URLSearchParams({ q, maxResults: '20' });
      if (req.query.pageToken) params.set('pageToken', String(req.query.pageToken).slice(0, 1024));
      const page = await gmailJson(supabase, req.user.id, `/messages?${params}`);
      const messages = await Promise.all((page.messages || []).map(async item => {
        const detail = await gmailJson(
          supabase,
          req.user.id,
          `/messages/${encodeURIComponent(item.id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        return metadata({ ...detail, snippet: item.snippet });
      }));
      res.json({ messages, nextPageToken: page.nextPageToken || '' });
    } catch (error) {
      routeError(res, 'listar mensagens', error);
    }
  });

  app.get('/api/email/messages/:messageId', requireAdmin, async (req, res) => {
    if (!/^[A-Za-z0-9_-]+$/.test(req.params.messageId)) return res.status(400).json({ error: 'Identificador de mensagem inválido.' });
    try {
      const detail = await gmailJson(
        supabase,
        req.user.id,
        `/messages/${encodeURIComponent(req.params.messageId)}?format=full`,
      );
      const content = { text: '', html: '', attachments: [] };
      walkParts(detail.payload, content);
      const summary = metadata(detail);
      const headers = headerMap(detail.payload);
      res.json({
        ...summary,
        cc: headers.cc || '',
        bodyText: content.text,
        bodyHtml: content.html,
        attachments: content.attachments,
      });
    } catch (error) {
      routeError(res, 'abrir mensagem', error);
    }
  });

  app.get('/api/email/messages/:messageId/attachments/:attachmentId', requireAdmin, async (req, res) => {
    if (!/^[A-Za-z0-9_-]+$/.test(req.params.messageId) || !/^[A-Za-z0-9_-]+$/.test(req.params.attachmentId)) {
      return res.status(400).json({ error: 'Identificador de anexo inválido.' });
    }
    try {
      const message = await gmailJson(
        supabase,
        req.user.id,
        `/messages/${encodeURIComponent(req.params.messageId)}?format=full`,
      );
      const content = { text: '', html: '', attachments: [] };
      walkParts(message.payload, content);
      const attachment = content.attachments.find(item => item.id === req.params.attachmentId);
      if (!attachment) return res.status(404).json({ error: 'O anexo não foi encontrado nesta mensagem.' });

      const result = await gmailJson(
        supabase,
        req.user.id,
        `/messages/${encodeURIComponent(req.params.messageId)}/attachments/${encodeURIComponent(req.params.attachmentId)}`,
      );
      const filename = String(attachment.filename || 'anexo').replace(/[\r\n"]/g, '_');
      const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/[\\;/]/g, '_');
      const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.mimeType) ? attachment.mimeType : 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(result.data || '', 'base64url'));
    } catch (error) {
      routeError(res, 'baixar anexo', error);
    }
  });
};
