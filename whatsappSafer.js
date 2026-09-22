// ════════════════════════════════════════════════════════
// UNIKO SAFER — Importação automática via WhatsApp Web
// Sessão de navegador persistente (Playwright) rodando na VPS: login por QR
// Code feito uma vez, sessão fica salva em disco (userDataDir) e sobrevive a
// reinícios do processo (PM2 restart/deploy).
//
// Este arquivo só automatiza o WhatsApp Web e devolve os arquivos exportados
// crus (buffer) — quem de fato importa pro Supabase (parse, hash, upload,
// RLS) continua sendo o frontend, reaproveitando a lógica que já existe e já
// está correta em src/modules/uniko-safer/ (evita duplicar essa lógica em
// duas linguagens).
//
// AVISO: os seletores do WhatsApp Web abaixo são melhor-esforço (baseados em
// role/texto acessível, mais resistentes a mudança de CSS que classes, mesmo
// padrão já usado na automação do Faturamento). A interface do WhatsApp Web
// muda com frequência — é esperado precisar ajustar isso depois do primeiro
// teste real contra uma conta logada de verdade.
// ════════════════════════════════════════════════════════

const { chromium } = require('playwright');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const crypto = require('crypto');

const WA_PROFILE_DIR = path.join(os.homedir(), '.uniko-safer-wa-profile');
const WA_JOB_TTL_MS   = 30 * 60 * 1000; // 30min depois de terminar, descarta os buffers

let waContext = null;
let waPage    = null;
const waJobs  = new Map(); // jobId → { status, logs, files, total, stopRequested, message }

/* ── Sessão persistente ──────────────────────────────────── */

async function getWaPage() {
  if (!waContext) {
    waContext = await chromium.launchPersistentContext(WA_PROFILE_DIR, {
      headless: true,
      acceptDownloads: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
  }
  if (!waPage || waPage.isClosed()) {
    waPage = waContext.pages()[0] || await waContext.newPage();
    // Esconde navigator.webdriver — mesma técnica já usada no Playwright do yt-dlp
    // (index.js) pra reduzir a chance de detecção de automação.
    await waPage.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }
  if (!waPage.url().includes('web.whatsapp.com')) {
    await waPage.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded' });
  }
  return waPage;
}

// `.isVisible()` do Playwright NÃO espera — checa o estado NA HORA. Usar
// `.waitFor()` de verdade evita pegar um estado de transição pela metade
// (ex: exatamente no instante entre escanear o QR e a lista carregar).
const waitVisible = (locator, timeout) =>
  locator.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);

async function getWaStatus() {
  const page = await getWaPage();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Login primeiro (dois sinais independentes — caixa de busca OU item da
  // lista), SEMPRE checado antes do QR: depois de escanear, um canvas do QR
  // pode continuar um instante no DOM (oculto) — checar login primeiro evita
  // ficar "preso" reportando precisar de QR mesmo já logado.
  const loggedIn =
    (await waitVisible(page.getByRole('textbox', { name: /pesquisar|search/i }).first(), 4000)) ||
    (await waitVisible(page.getByRole('row').first(), 2000));
  if (loggedIn) return { loggedIn: true };

  const qrCanvas = page.locator('canvas').first();
  const hasQr = await waitVisible(qrCanvas, 4000);
  if (hasQr) {
    const buf = await qrCanvas.screenshot().catch(() => null);
    if (buf) return { needsQr: true, qrImageBase64: buf.toString('base64') };
  }

  return { needsQr: false, loggedIn: false, message: 'Carregando WhatsApp Web...' };
}

/* ── Coleta de contatos da barra lateral ─────────────────── */

async function collectSidebarNames(page) {
  const names = new Set();
  let stableRounds = 0;

  for (let i = 0; i < 80 && stableRounds < 3; i++) {
    // A barra lateral do WhatsApp Web é um grid (role="grid" "Lista de
    // conversas") com linhas role="row" — NÃO role="listitem" (confirmado
    // inspecionando ao vivo em 22/set/2026; era por isso que nada era achado).
    const rows = await page.getByRole('row').all();
    const before = names.size;
    for (const row of rows) {
      const text = await row.innerText().catch(() => '');
      const firstLine = text.split('\n')[0]?.trim();
      if (firstLine) names.add(firstLine);
    }
    if (names.size === before) stableRounds++; else stableRounds = 0;
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(400);
  }
  return [...names];
}

/* ── Exportação de UMA conversa ──────────────────────────── */

async function exportContact(page, name) {
  const searchBox = page.getByRole('textbox', { name: /pesquisar/i }).first();
  await searchBox.click();
  await searchBox.fill(name);
  await page.waitForTimeout(700);

  // A busca também traz "Grupos em comum" onde o contato só é MEMBRO (não é
  // a própria conversa) — mas esses aparecem depois da seção "Conversas" no
  // DOM, então .first() sempre pega a conversa direta, nunca um grupo.
  const result = page.getByRole('row').filter({ hasText: name }).first();
  const found = await result.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (!found) throw new Error('Contato não encontrado na busca do WhatsApp Web.');
  await result.click();
  await page.waitForTimeout(500);

  // Botão do cabeçalho da conversa chama "Mais opções" (não "Menu") — existe
  // outro "Mais opções" global perto do título "WhatsApp", por isso .last()
  // (o da conversa aberta vem depois no DOM).
  const menuBtn = page.getByRole('button', { name: /mais opções/i }).last();
  await menuBtn.click();
  await page.waitForTimeout(300);

  const exportItem = page.getByText('Exportar conversa', { exact: true }).first();
  const hasExportItem = await exportItem.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
  if (!hasExportItem) throw new Error('Item "Exportar conversa" não apareceu no menu.');
  await exportItem.click();
  await page.waitForTimeout(500);

  // Diálogo "Exportar conversa": não existe escolha de mídia nessa versão —
  // só "Todas as mensagens" (já selecionado) / "Intervalo personalizado" e o
  // botão "Exportar", que já dispara o download direto.
  const confirmBtn = page.getByRole('button', { name: 'Exportar', exact: true }).last();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    confirmBtn.click(),
  ]);

  const filePath = await download.path();
  const buffer   = await fs.promises.readFile(filePath);
  const filename = download.suggestedFilename() || `${name}.txt`;

  // Limpa a busca pro próximo contato (botão "Fechar" do campo de busca).
  const clearBtn = page.getByRole('button', { name: /fechar/i }).first();
  if (await clearBtn.isVisible().catch(() => false)) await clearBtn.click().catch(() => {});

  return { buffer, filename };
}

/* ── Loop principal do job ───────────────────────────────── */

async function runWhatsappImport(jobId, pauseSeconds) {
  const job = waJobs.get(jobId);
  const log = (entry) => job.logs.push(entry);

  try {
    const page = await getWaPage();
    const status = await getWaStatus();
    if (!status.loggedIn) {
      job.status = 'error';
      job.message = 'WhatsApp Web não está logado — escaneie o QR Code primeiro.';
      return;
    }

    log({ type: 'info', message: 'Carregando lista de contatos...' });
    const names = await collectSidebarNames(page);
    job.total = names.length;
    log({ type: 'info', message: `${names.length} contato(s) encontrado(s) na barra lateral.` });

    for (let i = 0; i < names.length; i++) {
      if (job.stopRequested) {
        log({ type: 'info', message: 'Interrompido pelo usuário.' });
        break;
      }
      const name = names[i];
      try {
        const { buffer, filename } = await exportContact(page, name);
        const fileIndex = job.files.length;
        job.files.push({ buffer, filename });
        log({ contactName: name, fileIndex, status: 'ready', message: 'Exportado com sucesso.' });
      } catch (err) {
        log({ contactName: name, status: 'error', message: err.message });
        console.error(`[uniko-safer-wa] erro em "${name}":`, err.message);
      }
      if (i < names.length - 1 && !job.stopRequested) {
        await new Promise((r) => setTimeout(r, pauseSeconds * 1000));
      }
    }

    job.status = job.status === 'error' ? job.status : 'done';
  } catch (err) {
    job.status = 'error';
    job.message = err.message;
    log({ type: 'error', message: `Erro inesperado: ${err.message}` });
  } finally {
    setTimeout(() => waJobs.delete(jobId), WA_JOB_TTL_MS);
  }
}

/* ── Rotas ────────────────────────────────────────────────── */

module.exports = function registerWhatsappSaferRoutes(app, { requireAdminOrModerador }) {
  app.get('/api/safer/whatsapp/status', requireAdminOrModerador, async (req, res) => {
    try {
      res.json(await getWaStatus());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/safer/whatsapp/import/start', requireAdminOrModerador, (req, res) => {
    const pauseSeconds = Math.max(5, Number(req.body?.pauseSeconds) || 8);
    const jobId = crypto.randomUUID();
    waJobs.set(jobId, { status: 'running', logs: [], files: [], total: 0, stopRequested: false, message: null });
    res.json({ jobId });
    runWhatsappImport(jobId, pauseSeconds).catch((err) => {
      const j = waJobs.get(jobId);
      if (j) { j.status = 'error'; j.message = err.message; }
    });
  });

  app.get('/api/safer/whatsapp/import/status/:jobId', requireAdminOrModerador, (req, res) => {
    const job = waJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job não encontrado (pode ter expirado).' });
    res.json({ status: job.status, logs: job.logs, total: job.total, message: job.message });
  });

  app.get('/api/safer/whatsapp/import/:jobId/file/:idx', requireAdminOrModerador, (req, res) => {
    const job = waJobs.get(req.params.jobId);
    const file = job?.files?.[Number(req.params.idx)];
    if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    const isZip = /\.zip$/i.test(file.filename);
    res.setHeader('Content-Type', isZip ? 'application/zip' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.send(file.buffer);
  });

  app.post('/api/safer/whatsapp/import/stop/:jobId', requireAdminOrModerador, (req, res) => {
    const job = waJobs.get(req.params.jobId);
    if (job) job.stopRequested = true;
    res.json({ ok: true });
  });
};
