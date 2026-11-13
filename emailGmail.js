const crypto = require('crypto');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_BATCH_API_URL = 'https://www.googleapis.com/batch/gmail/v1';
const TOKEN_KEY_PREFIX = 'gmail_oauth_user_';
const SHARED_TOKEN_KEY = 'gmail_oauth_shared';
const SHARED_MAILBOX_EMAIL = 'faturamento@7beneficios.com';
const oauthStates = new Map();
const refreshes = new Map();
const faturamentoCache = new Map();
const faturamentoRequests = new Map();
const faturamentoCooldowns = new Map();
const faturamentoQuotaFailures = new Map();
const gmailQueryCooldowns = new Map();
const FATURAMENTO_CACHE_TTL = 24 * 60 * 60 * 1000;
const FATURAMENTO_CACHE_FRESH_TTL = 14 * 60 * 1000;
const FATURAMENTO_COOLDOWN_DEFAULT = 60;
const FATURAMENTO_COOLDOWN_MAX = 15 * 60;

function limparCacheFaturamento(userId) {
  const prefixo = `${String(userId)}:`;
  for (const key of faturamentoCache.keys()) {
    if (key.startsWith(prefixo)) faturamentoCache.delete(key);
  }
  faturamentoCooldowns.delete(String(userId));
  faturamentoQuotaFailures.delete(String(userId));
}

function iniciarCooldownFaturamento(scopeKey, retryAfter = 0) {
  const key = String(scopeKey);
  const tentativas = (faturamentoQuotaFailures.get(key) || 0) + 1;
  faturamentoQuotaFailures.set(key, tentativas);
  const esperaExponencial = Math.min(
    FATURAMENTO_COOLDOWN_MAX,
    FATURAMENTO_COOLDOWN_DEFAULT * (2 ** Math.min(tentativas - 1, 10)),
  );
  const espera = Math.max(esperaExponencial, Number(retryAfter) || 0);
  faturamentoCooldowns.set(key, Date.now() + espera * 1000);
  if (faturamentoCooldowns.size > 500) {
    for (const [id, until] of faturamentoCooldowns) {
      if (until <= Date.now()) {
        faturamentoCooldowns.delete(id);
        faturamentoQuotaFailures.delete(id);
      }
    }
  }
  return espera;
}

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

async function loadAccountByKey(supabase, key) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ? decrypt(data.value) : null;
}

async function loadAccount(supabase, userId) {
  return loadAccountByKey(supabase, tokenKey(userId));
}

async function saveAccountByKey(supabase, key, account) {
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value: encrypt(account) });
  if (error) throw error;
}

async function saveAccount(supabase, userId, account) {
  return saveAccountByKey(supabase, tokenKey(userId), account);
}

async function resolveAccountReference(supabase, userId) {
  const shared = await loadAccountByKey(supabase, SHARED_TOKEN_KEY);
  if (shared?.refresh_token && shared.email) {
    return { key: SHARED_TOKEN_KEY, scope: 'shared', account: shared, shared: true };
  }
  const key = tokenKey(userId);
  return {
    key,
    scope: String(userId),
    account: await loadAccountByKey(supabase, key),
    shared: false,
  };
}

class GoogleError extends Error {
  constructor(message, status, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function retryAfterSeconds(response) {
  const header = response.headers.get('Retry-After');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(header);
  return Number.isNaN(date) ? 0 : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function isQuotaError(error) {
  return error.status === 429 || (error.status === 403 && /quota|rate limit/i.test(error.message));
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function postGoogleForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GoogleError(data.error_description || data.error || 'O Google recusou a solicitação.', response.status, retryAfterSeconds(response));
  }
  return data;
}

async function googleJson(accessToken, path) {
  const response = await fetch(`${GMAIL_API_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GoogleError(data.error?.message || 'Não foi possível consultar o Gmail.', response.status, retryAfterSeconds(response));
  }
  return data;
}

async function googleBatchJson(accessToken, paths) {
  const boundary = `batch_${crypto.randomBytes(16).toString('hex')}`;
  const body = paths.map((path, index) => [
    `--${boundary}`,
    'Content-Type: application/http',
    `Content-ID: <item-${index}>`,
    '',
    `GET ${path} HTTP/1.1`,
    '',
    '',
  ].join('\r\n')).join('') + `--${boundary}--\r\n`;
  const response = await fetch(GMAIL_BATCH_API_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': `multipart/mixed; boundary=${boundary}`,
    },
    body,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new GoogleError(data.error?.message || 'Não foi possível consultar o Gmail.', response.status, retryAfterSeconds(response));
  }

  const responseType = response.headers.get('Content-Type') || '';
  const responseBoundary = responseType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!responseBoundary) throw new Error('O Gmail retornou uma resposta de pesquisa inválida.');
  const parts = (await response.text()).split(`--${responseBoundary}`).filter(part => /HTTP\/1\.[01]\s+\d{3}/.test(part));
  const results = new Array(paths.length);
  for (const [partIndex, part] of parts.entries()) {
    const contentId = part.match(/Content-ID:\s*<response-item-(\d+)>/i)?.[1];
    const index = contentId === undefined ? partIndex : Number(contentId);
    const httpResponse = part.match(/HTTP\/1\.[01]\s+(\d{3})[^\r\n]*\r?\n([\s\S]*)/);
    if (!httpResponse || index >= paths.length) throw new Error('O Gmail retornou um item inválido na pesquisa.');
    const status = Number(httpResponse[1]);
    const jsonStart = httpResponse[2].indexOf('\r\n\r\n');
    if (jsonStart === -1) throw new Error('O Gmail retornou um item incompleto na pesquisa.');
    const data = JSON.parse(httpResponse[2].slice(jsonStart + 4).trim());
    if (status < 200 || status >= 300) {
      throw new GoogleError(data.error?.message || 'Não foi possível consultar o Gmail.', status, 0);
    }
    results[index] = data;
  }
  if (results.some(result => result === undefined)) throw new Error('O Gmail não retornou todos os resultados da pesquisa.');
  return results;
}

async function accessToken(supabase, accountReference, forceRefresh = false) {
  const { account, key } = accountReference;
  if (!account?.refresh_token) {
    throw new GoogleError('Conecte uma conta Gmail para continuar.', 401);
  }
  if (!forceRefresh && account.expiry_date > Date.now() + 60_000 && account.access_token) {
    return { account, token: account.access_token };
  }
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
      await saveAccountByKey(supabase, key, updated);
      return { account: updated, token: updated.access_token };
    })();
    refreshes.set(key, refresh);
  }
  try {
    const refreshed = await refresh;
    accountReference.account = refreshed.account;
    return refreshed;
  } finally {
    if (refreshes.get(key) === refresh) refreshes.delete(key);
  }
}

async function gmailJson(supabase, accountReference, path) {
  let credentials = await accessToken(supabase, accountReference);
  try {
    return await googleJson(credentials.token, path);
  } catch (error) {
    if (error.status !== 401) throw error;
    credentials = await accessToken(supabase, accountReference, true);
    return googleJson(credentials.token, path);
  }
}

async function gmailBatchJson(supabase, accountReference, paths) {
  let credentials = await accessToken(supabase, accountReference);
  try {
    return await googleBatchJson(credentials.token, paths);
  } catch (error) {
    if (error.status !== 401) throw error;
    credentials = await accessToken(supabase, accountReference, true);
    return googleBatchJson(credentials.token, paths);
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

function attachmentsFromParts(part, attachments = []) {
  if (!part) return attachments;
  const mimeType = String(part.mimeType || 'application/octet-stream');
  const filename = part.filename || (mimeType.toLowerCase() === 'application/pdf' ? 'anexo.pdf' : '');
  if (filename && (part.body?.attachmentId || part.body?.data)) {
    const attachment = {
      id: part.body.attachmentId,
      filename,
      mimeType,
      size: Number(part.body.size) || 0,
    };
    if (part.body.data && !part.body.attachmentId) attachment.data = part.body.data;
    attachments.push(attachment);
  }
  for (const child of part.parts || []) attachmentsFromParts(child, attachments);
  return attachments;
}

function metadata(message) {
  const headers = headerMap(message.payload);
  return {
    id: message.id,
    threadId: message.threadId,
    internalDate: message.internalDate || '',
    labelIds: message.labelIds || [],
    snippet: message.snippet || '',
    from: headers.from || '',
    to: headers.to || '',
    subject: headers.subject || '',
    date: headers.date || '',
  };
}

function personalizarFaturamento(data, senderName) {
  return {
    ...data,
    senderName,
    messages: (data.messages || []).map(message => ({ ...message, senderName })),
  };
}

function ignoredMessage(message, { includeReplies = false } = {}) {
  const headers = headerMap(message.payload);
  const sender = String(headers.from || '').toLowerCase();
  const subject = String(headers.subject || '').trim().toLowerCase();
  const isMailsuite = /mailsuite|mail[\s._-]*track/.test(`${sender} ${subject}`);
  const isReply = Boolean(headers['in-reply-to'] || headers.references)
    || /^(re|res|fw|fwd)\s*:/i.test(subject);
  return isMailsuite || (!includeReplies && isReply);
}

function routeError(res, label, error, scopeKey) {
  const quotaExceeded = isQuotaError(error);
  const retryAfter = quotaExceeded ? (error.retryAfter || FATURAMENTO_COOLDOWN_DEFAULT) : 0;
  if (quotaExceeded && scopeKey) {
    gmailQueryCooldowns.set(String(scopeKey), Date.now() + retryAfter * 1000);
    if (gmailQueryCooldowns.size > 500) {
      for (const [id, until] of gmailQueryCooldowns) {
        if (until <= Date.now()) gmailQueryCooldowns.delete(id);
      }
    }
  }
  const status = quotaExceeded ? 429 : error instanceof GoogleError && error.status >= 400 && error.status < 500
    ? error.status
    : 502;
  console.error(`[Gmail] ${label}:`, error.message);
  if (quotaExceeded) res.setHeader('Retry-After', String(retryAfter));
  res.status(status).json({
    error: quotaExceeded
      ? `O Gmail atingiu o limite temporário de consultas. Tente novamente em ${retryAfter} segundos.`
      : status === 401
        ? 'A autorização do Gmail não está ativa. Conecte a conta novamente.'
        : error.message || 'Falha ao consultar o Gmail.',
    ...(quotaExceeded ? { retryAfter } : {}),
  });
}

function responderSeEmCooldown(userId, res) {
  const key = String(userId);
  const until = gmailQueryCooldowns.get(key) || 0;
  if (until <= Date.now()) {
    gmailQueryCooldowns.delete(key);
    return false;
  }
  const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  res.setHeader('Retry-After', String(retryAfter));
  res.status(429).json({
    error: `A busca no Gmail está pausada para respeitar a cota. Tente novamente em ${retryAfter} segundos.`,
    retryAfter,
  });
  return true;
}

module.exports = function registerEmailRoutes(app, { supabase, requireAuth }) {
  app.use('/api/email', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  });

  app.get('/api/email/status', requireAuth, async (req, res) => {
    try {
      if (!configurationReady()) return res.json({ configured: false, connected: false });
      const accountReference = await resolveAccountReference(supabase, req.user.id);
      const account = accountReference.account;
      res.json({
        configured: true,
        connected: Boolean(account?.refresh_token && account.email),
        email: account?.email || '',
        shared: accountReference.shared,
        canShareAccount: !accountReference.shared
          && req.user.role === 'admin'
          && account?.email?.toLowerCase() === SHARED_MAILBOX_EMAIL,
      });
    } catch (error) {
      routeError(res, 'status', error);
    }
  });

  app.post('/api/email/shared-account', requireAuth, async (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Somente administradores podem definir a caixa institucional.' });
    }
    try {
      const account = await loadAccount(supabase, req.user.id);
      if (account?.email?.toLowerCase() !== SHARED_MAILBOX_EMAIL || !account.refresh_token) {
        return res.status(409).json({
          error: `Conecte primeiro a conta ${SHARED_MAILBOX_EMAIL} neste usuário administrador.`,
        });
      }
      await saveAccountByKey(supabase, SHARED_TOKEN_KEY, account);
      limparCacheFaturamento('shared');
      gmailQueryCooldowns.delete('shared');
      res.json({ ok: true, email: account.email });
    } catch (error) {
      routeError(res, 'compartilhar caixa institucional', error);
    }
  });

  app.post('/api/email/oauth/start', requireAuth, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Somente administradores podem conectar a caixa institucional.' });
    }
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
      limparCacheFaturamento(entry.userId);
      res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Gmail conectado</title><body style="font:16px sans-serif;text-align:center;padding:48px;color:#234"><h2>Gmail conectado ao Uniko</h2><p>Você já pode voltar ao módulo E-mail.</p><script>setTimeout(()=>window.close(),700)</script></body></html>');
    } catch (error) {
      console.error('[Gmail] OAuth callback:', error.message);
      res.type('html').send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Falha na conexão</title><body style="font:16px sans-serif;text-align:center;padding:48px;color:#234"><h2>Não foi possível conectar o Gmail</h2><p>Feche esta janela e tente novamente pelo Uniko.</p><script>setTimeout(()=>window.close(),3500)</script></body></html>');
    }
  });

  app.delete('/api/email/disconnect', requireAuth, async (req, res) => {
    try {
      const { error } = await supabase.from('settings').delete().eq('key', tokenKey(req.user.id));
      if (error) return routeError(res, 'desconectar conta', error);
      limparCacheFaturamento(req.user.id);
      res.json({ ok: true });
    } catch (error) {
      routeError(res, 'desconectar conta', error);
    }
  });

  app.get('/api/email/messages', requireAuth, async (req, res) => {
    let scopeKey = String(req.user.id);
    try {
      const accountReference = await resolveAccountReference(supabase, req.user.id);
      scopeKey = accountReference.scope;
      if (req.query.includeAttachments === '1' && responderSeEmCooldown(accountReference.scope, res)) return;
      const q = String(req.query.q || 'in:inbox').slice(0, 300);
      const includeAttachments = req.query.includeAttachments === '1';
      const includeReplies = req.query.includeReplies === '1';
      const params = new URLSearchParams({ q, maxResults: includeAttachments ? '10' : '20' });
      if (req.query.pageToken) params.set('pageToken', String(req.query.pageToken).slice(0, 1024));
      const page = await gmailJson(supabase, accountReference, `/messages?${params}`);
      const items = page.messages || [];
      const headers = ['From', 'To', 'Subject', 'Date', 'In-Reply-To', 'References'];
      const paths = items.map(item => {
        const detailParams = new URLSearchParams({ format: includeAttachments ? 'full' : 'metadata' });
        if (!includeAttachments) {
          for (const header of headers) detailParams.append('metadataHeaders', header);
        }
        return `/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?${detailParams}`;
      });
      const details = paths.length
        ? await gmailBatchJson(supabase, accountReference, paths)
        : [];
      details.forEach((detail, index) => { detail.snippet = items[index].snippet; });
      const messages = details.filter(item => !ignoredMessage(item, { includeReplies })).map(detail => ({
        ...metadata(detail),
        ...(includeAttachments ? { attachments: attachmentsFromParts(detail.payload) } : {}),
      }));
      res.json({ messages, nextPageToken: page.nextPageToken || '' });
    } catch (error) {
      routeError(res, 'listar mensagens', error, scopeKey);
    }
  });

  app.get('/api/email/faturamento', requireAuth, async (req, res) => {
    const startDate = String(req.query.startDate || '');
    const endDate = String(req.query.endDate || '');
    const month = String(req.query.month || (!startDate && !endDate ? new Date().toISOString().slice(0, 7) : '')).slice(0, 7);
    const usaIntervaloDias = Boolean(startDate || endDate);
    if (usaIntervaloDias) {
      if (!startDate || !endDate || !isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate) {
        return res.status(400).json({ error: 'Informe um intervalo de datas válido para consultar o faturamento.' });
      }
      if (month) return res.status(400).json({ error: 'Escolha um mês inteiro ou um intervalo de dias, não os dois.' });
    } else if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Informe um mês válido para consultar o faturamento.' });
    } else if (!month) {
      return res.status(400).json({ error: 'Informe o mês ou o intervalo de datas para consultar o faturamento.' });
    }
    const filterKey = usaIntervaloDias ? `date:${startDate}:${endDate}` : `month:${month}`;
    const forcarAtualizacao = req.query.refresh === '1';
    const pageToken = String(req.query.pageToken || '');
    if (pageToken.length > 1024) {
      return res.status(400).json({ error: 'A página solicitada para o histórico é inválida.' });
    }

    let accountReference;
    try {
      accountReference = await resolveAccountReference(supabase, req.user.id);
    } catch (error) {
      routeError(res, 'consultar faturamento', error, String(req.user.id));
      return;
    }

    const scopeKey = accountReference.scope;
    const cacheKey = `${scopeKey}:${filterKey}:${pageToken}`;
    const cached = faturamentoCache.get(cacheKey);
    if (!forcarAtualizacao && cached && Date.now() - cached.cachedAt < FATURAMENTO_CACHE_FRESH_TTL) {
      return res.json({
        ...personalizarFaturamento(cached.data, req.user.name || ''),
        cached: true,
        cachedAt: new Date(cached.cachedAt).toISOString(),
      });
    }

    const cooldownUntil = faturamentoCooldowns.get(scopeKey) || 0;
    if (cooldownUntil > Date.now()) {
      const retryAfter = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (cached) {
        return res.json({
          ...personalizarFaturamento(cached.data, req.user.name || ''),
          cached: true,
          stale: true,
          cachedAt: new Date(cached.cachedAt).toISOString(),
          warning: 'O Gmail está temporariamente limitado. Exibindo a última sincronização disponível.',
        });
      }
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: `O Gmail atingiu o limite temporário de consultas. Tente novamente em ${retryAfter} segundos.`,
        retryAfter,
      });
    }
    if (cooldownUntil) faturamentoCooldowns.delete(scopeKey);

    let request = faturamentoRequests.get(cacheKey);
    if (!request) {
      request = (async () => {
      const account = accountReference.account;
      if (!account?.refresh_token || !account.email) {
        throw new GoogleError('A caixa Gmail institucional ainda não está conectada.', 401);
      }

      const [year, monthNumber] = month.split('-').map(Number);
      const start = usaIntervaloDias
        ? startDate.replace(/-/g, '/')
        : `${year}/${String(monthNumber).padStart(2, '0')}/01`;
      const nextMonth = new Date(Date.UTC(year, monthNumber, 1));
      const endExclusive = usaIntervaloDias
        ? new Date(`${endDate}T00:00:00.000Z`)
        : nextMonth;
      if (usaIntervaloDias) endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
      const end = `${endExclusive.getUTCFullYear()}/${String(endExclusive.getUTCMonth() + 1).padStart(2, '0')}/${String(endExclusive.getUTCDate()).padStart(2, '0')}`;
      const query = `in:sent after:${start} before:${end} {"nota fiscal" "nota fiscal eletrônica" "NF-e" DANFE faturamento refaturamento fatura}`;
      const headers = ['From', 'To', 'Subject', 'Date'];
      const params = new URLSearchParams({ q: query, maxResults: '50' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await gmailJson(supabase, accountReference, `/messages?${params}`);
      const items = page.messages || [];
      const paths = items.map(item => {
        const detailParams = new URLSearchParams({ format: 'metadata' });
        for (const header of headers) detailParams.append('metadataHeaders', header);
        return `/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?${detailParams}`;
      });
      const details = paths.length
        ? await gmailBatchJson(supabase, accountReference, paths)
        : [];
      details.forEach((detail, index) => { detail.snippet = items[index].snippet || ''; });
      const messages = details
        .filter(detail => {
          const messageHeaders = headerMap(detail.payload);
          return !/mailsuite|mail[\s._-]*track/i.test(`${messageHeaders.from || ''} ${messageHeaders.subject || ''}`);
        })
        .map(detail => ({ ...metadata(detail), senderName: req.user.name || '' }));

      return {
        month,
        filterKey,
        mailbox: account.email,
        senderName: req.user.name || '',
        messages,
        nextPageToken: page.nextPageToken || '',
        truncated: Boolean(page.nextPageToken),
      };
      })();
      faturamentoRequests.set(cacheKey, request);
    }

    try {
      const data = await request;
      faturamentoCooldowns.delete(scopeKey);
      faturamentoQuotaFailures.delete(scopeKey);
      const cachedAt = Date.now();
      faturamentoCache.set(cacheKey, { data, cachedAt });
      if (faturamentoCache.size > 500) {
        for (const [key, value] of faturamentoCache) {
          if (cachedAt - value.cachedAt >= FATURAMENTO_CACHE_TTL) faturamentoCache.delete(key);
        }
        while (faturamentoCache.size > 500) {
          faturamentoCache.delete(faturamentoCache.keys().next().value);
        }
      }
      res.json({
        ...personalizarFaturamento(data, req.user.name || ''),
        cached: false,
        cachedAt: new Date(cachedAt).toISOString(),
      });
    } catch (error) {
      const retryAfter = isQuotaError(error)
        ? iniciarCooldownFaturamento(scopeKey, error.retryAfter || FATURAMENTO_COOLDOWN_DEFAULT)
        : 0;
      if (cached && isQuotaError(error)) {
        return res.json({
          ...personalizarFaturamento(cached.data, req.user.name || ''),
          cached: true,
          stale: true,
          cachedAt: new Date(cached.cachedAt).toISOString(),
          warning: 'O Gmail atingiu o limite temporário de consultas. Exibindo a última sincronização disponível.',
        });
      }
      if (isQuotaError(error)) {
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: `O Gmail atingiu o limite temporário de consultas. Tente novamente em ${retryAfter} segundos.`,
          retryAfter,
        });
      }
      routeError(res, 'consultar faturamento', error, scopeKey);
    } finally {
      if (faturamentoRequests.get(cacheKey) === request) faturamentoRequests.delete(cacheKey);
    }
  });

  app.get('/api/email/messages/:messageId', requireAuth, async (req, res) => {
    if (!/^[A-Za-z0-9_-]+$/.test(req.params.messageId)) return res.status(400).json({ error: 'Identificador de mensagem inválido.' });
    let scopeKey = String(req.user.id);
    try {
      const accountReference = await resolveAccountReference(supabase, req.user.id);
      scopeKey = accountReference.scope;
      const detail = await gmailJson(
        supabase,
        accountReference,
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
      routeError(res, 'abrir mensagem', error, scopeKey);
    }
  });

  app.get('/api/email/messages/:messageId/attachments/:attachmentId', requireAuth, async (req, res) => {
    if (!/^[A-Za-z0-9_-]+$/.test(req.params.messageId) || !/^[A-Za-z0-9_-]+=*$/.test(req.params.attachmentId)) {
      return res.status(400).json({ error: 'Identificador de anexo inválido.' });
    }
    let scopeKey = String(req.user.id);
    try {
      const accountReference = await resolveAccountReference(supabase, req.user.id);
      scopeKey = accountReference.scope;
      if (responderSeEmCooldown(scopeKey, res)) return;
      const result = await gmailJson(
        supabase,
        accountReference,
        `/messages/${encodeURIComponent(req.params.messageId)}/attachments/${encodeURIComponent(req.params.attachmentId)}`,
      );
      const filename = String(req.query.filename || 'anexo').replace(/[\r\n"]/g, '_');
      const asciiFilename = filename.replace(/[^\x20-\x7E]/g, '_').replace(/[\\;/]/g, '_');
      const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(req.query.mimeType) ? req.query.mimeType : 'application/octet-stream';
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(Buffer.from(result.data || '', 'base64url'));
    } catch (error) {
      routeError(res, 'baixar anexo', error, scopeKey);
    }
  });
};
