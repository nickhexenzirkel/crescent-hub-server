// ════════════════════════════════════════════════════════
// BAIXAR ORDENS DE SERVIÇO (Oficina Estelar, só admin) — robô Playwright que
// refaz, no sistema da Wowlet (7 Benefícios Gestão), o caminho que o Nicolas
// faz à mão: login → Credenciados → busca pelo nome → Acessar → Ordens de
// Serviço → busca pelo ID → abre a ordem → imprime a página em PDF (Ctrl+P).
//
// Usuário/senha da Wowlet chegam no POST e ficam SÓ na memória do job (nunca
// em disco/log). Os PDFs ficam numa pasta temporária por job e o front monta
// o .zip (pastas Secretaria/Setor) baixando um a um. Um job por vez.
// Cada credenciado usa um contexto de navegador novo (login novo), porque
// depois do "Acessar" a sessão fica presa naquele credenciado.
// ════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');

const BASE = 'https://app.7beneficiosgestao.com.br';
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
const T_NAV = 30000;

const jobs = new Map();

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const slug = (s) => String(s || 'sem-nome').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) || 'sem-nome';

const log = (job, msg) => { job.logs.push({ t: Date.now(), msg }); if (job.logs.length > 600) job.logs.shift(); };

async function screenshot(job, page, nome) {
  try { await page.screenshot({ path: path.join(job.dir, `erro-${nome}.png`), fullPage: true }); } catch { /* sem print */ }
}

async function login(job, page, usuario, senha) {
  log(job, 'Abrindo a tela de login da Wowlet…');
  await page.goto(`${BASE}/sessions/new`, { waitUntil: 'domcontentloaded', timeout: T_NAV });
  await page.getByRole('textbox', { name: 'Nome de Usuário' }).fill(usuario);
  await page.getByRole('textbox', { name: 'Senha' }).fill(senha);
  log(job, 'Enviando usuário e senha…');
  await page.getByRole('textbox', { name: 'Senha' }).press('Enter');
  await page.getByRole('link', { name: 'Credenciados' }).first().waitFor({ timeout: T_NAV })
    .catch(() => { throw new Error('Login na Wowlet não passou (usuário/senha errados, captcha ou bloqueio).'); });
  log(job, 'Login feito.');
}

/** Busca o credenciado e entra nele ("Acessar"). Tenta o nome inteiro e depois pedaços menores. */
async function acessarCredenciado(job, page, nome) {
  const alvo = norm(nome);
  const buscas = [...new Set([nome.trim(), nome.split(' - ')[0].trim(), nome.trim().split(/\s+/)[0]])].filter(Boolean);
  for (const termo of buscas) {
    log(job, `Indo em Credenciados e pesquisando "${termo}"…`);
    await page.getByRole('link', { name: 'Credenciados' }).first().click();
    await page.waitForLoadState('domcontentloaded');
    let campo = page.getByRole('searchbox').first();
    if (!(await campo.isVisible().catch(() => false))) {
      // na gravação havia dois toggles antes do campo de busca
      for (const i of [2, 3]) await page.getByLabel('').nth(i).click({ timeout: 2000 }).catch(() => {});
      campo = page.getByRole('searchbox').first();
    }
    await campo.fill(termo);
    await page.getByRole('button', { name: 'Buscar' }).first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const linhas = page.getByRole('row').filter({ hasText: new RegExp(termo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
    const n = await linhas.count();
    log(job, `${n} linha(s) encontrada(s) para "${termo}".`);
    let escolhida = null;
    for (let i = 0; i < n; i++) {
      const txt = norm(await linhas.nth(i).innerText().catch(() => ''));
      if (txt.includes(alvo)) { escolhida = linhas.nth(i); break; }
    }
    if (!escolhida && n === 1) escolhida = linhas.first();
    if (!escolhida) continue;
    let acessar = escolhida.getByRole('link', { name: 'Acessar' }).first();
    if (!(await acessar.count())) {
      await escolhida.getByRole('cell').first().click().catch(() => {});
      acessar = escolhida.getByRole('link', { name: 'Acessar' }).first();
    }
    if (!(await acessar.count())) continue;
    log(job, 'Clicando em Acessar…');
    await acessar.click();
    await page.waitForLoadState('domcontentloaded');
    log(job, 'Dentro do credenciado. Indo direto para /provider_orders.');
    await page.goto(`${BASE}/provider_orders`, { waitUntil: 'domcontentloaded', timeout: T_NAV });
    return;
  }
  throw new Error(`Credenciado não encontrado na Wowlet: ${nome}`);
}

/** Dentro do credenciado: acha a ordem pelo ID e salva o PDF. Devolve o caminho do arquivo. */
async function baixarOrdem(job, page, id, destino) {
  log(job, `OS ${id}: abrindo /provider_orders…`);
  await page.goto(`${BASE}/provider_orders`, { waitUntil: 'domcontentloaded', timeout: T_NAV });
  const campo = page.locator('input[name="order_id"]');
  await campo.waitFor({ timeout: T_NAV });
  log(job, `OS ${id}: preenchendo o ID e clicando em Buscar…`);
  await campo.fill(id);
  await page.getByRole('button', { name: 'Buscar' }).first().click();
  const link = page.getByRole('link', { name: id }).first();
  await link.waitFor({ timeout: 20000 }).catch(() => { throw new Error('Ordem não encontrada nesse credenciado.'); });
  log(job, `OS ${id}: abrindo a ordem…`);
  await link.click();
  // Ctrl+P da página da ordem: em headless o equivalente é page.pdf() (imprime como a janela de impressão).
  await page.getByText(/Ordem de Serviço:/).first().waitFor({ timeout: T_NAV });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  log(job, `OS ${id}: imprimindo a página em PDF (Ctrl+P)…`);
  await page.pdf({ path: destino, format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' } });
  if (!fs.existsSync(destino) || fs.statSync(destino).size < 500) throw new Error('PDF baixado veio vazio.');
  log(job, `OS ${id}: PDF salvo (${Math.round(fs.statSync(destino).size / 1024)} KB).`);
}

async function rodar(job, { usuario, senha }) {
  job.status = 'rodando';
  const grupos = new Map();
  job.itens.forEach((it) => {
    if (!grupos.has(it.credenciado)) grupos.set(it.credenciado, []);
    grupos.get(it.credenciado).push(it);
  });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  job.browser = browser;
  try {
    for (const [cred, itens] of grupos) {
      if (job.cancelado) break;
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(T_NAV);
      try {
        log(job, `── Credenciado: ${cred} (${itens.length} ordem(ns))`);
        await login(job, page, usuario, senha);
        await acessarCredenciado(job, page, cred);
      } catch (e) {
        log(job, `ERRO no credenciado ${cred}: ${e.message}`);
        await screenshot(job, page, slug(cred));
        itens.forEach((it) => { it.estado = 'erro'; it.msg = e.message; });
        await context.close().catch(() => {});
        continue;
      }
      for (const it of itens) {
        if (job.cancelado) break;
        it.estado = 'baixando';
        const destino = path.join(job.dir, `${it.idx}.pdf`);
        for (let tentativa = 1; tentativa <= 2; tentativa++) {
          try {
            await baixarOrdem(job, page, it.os, destino);
            it.estado = 'ok'; it.msg = ''; it.arquivo = destino;
            break;
          } catch (e) {
            it.estado = 'erro'; it.msg = e.message;
            log(job, `OS ${it.os}: falhou (tentativa ${tentativa}/2) — ${e.message}`);
            if (tentativa === 2) await screenshot(job, page, `${it.idx}-${it.os}`);
            else await page.goBack().catch(() => {});
          }
        }
      }
      await context.close().catch(() => {});
    }
    job.status = job.cancelado ? 'cancelado' : 'concluido';
    log(job, job.cancelado ? 'Cancelado.' : 'Concluído.');
  } catch (e) {
    job.status = 'erro'; job.erro = e.message;
  } finally {
    await browser.close().catch(() => {});
    job.browser = null;
    job.fim = Date.now();
    job.itens.forEach((it) => { if (it.estado === 'fila' || it.estado === 'baixando') { it.estado = 'erro'; it.msg = it.msg || 'Não processada.'; } });
  }
}

function publico(job) {
  return {
    id: job.id, status: job.status, erro: job.erro || null, logs: job.logs.slice(-250),
    itens: job.itens.map(({ idx, os: o, credenciado, setor, secretaria, estado, msg }) => ({ idx, os: o, credenciado, setor, secretaria, estado, msg })),
  };
}

module.exports = function registerWowletOS(app, { requireAdmin }) {
  setInterval(() => {
    for (const [id, j] of jobs) {
      if (j.fim && Date.now() - j.fim > JOB_TTL_MS) { fs.rm(j.dir, { recursive: true, force: true }, () => {}); jobs.delete(id); }
    }
  }, 10 * 60 * 1000).unref();

  app.post('/api/wowlet-os/start', requireAdmin, (req, res) => {
    const { usuario, senha, itens } = req.body || {};
    if (!usuario || !senha) return res.status(400).json({ error: 'Informe usuário e senha da Wowlet.' });
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'Nenhuma ordem na lista.' });
    if (itens.length > 400) return res.status(400).json({ error: 'Máximo de 400 ordens por vez.' });
    if ([...jobs.values()].some((j) => j.status === 'rodando')) return res.status(409).json({ error: 'Já existe um download em andamento. Aguarde terminar.' });
    const id = crypto.randomUUID();
    const job = {
      id, status: 'fila', logs: [], dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wowlet-os-')),
      itens: itens.map((it, idx) => ({
        idx, os: String(it.os || '').trim(), credenciado: String(it.credenciado || '').trim(),
        setor: String(it.setor || ''), secretaria: String(it.secretaria || ''), estado: 'fila', msg: '',
      })).filter((it) => it.os && it.credenciado),
    };
    if (!job.itens.length) return res.status(400).json({ error: 'Nenhuma ordem válida (faltou ID ou credenciado).' });
    jobs.set(id, job);
    log(job, `Iniciando: ${job.itens.length} ordem(ns).`);
    rodar(job, { usuario: String(usuario), senha: String(senha) }).catch((e) => { job.status = 'erro'; job.erro = e.message; job.fim = Date.now(); });
    res.json(publico(job));
  });

  app.get('/api/wowlet-os/:id', requireAdmin, (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job não encontrado (expirou?).' });
    res.json(publico(job));
  });

  app.get('/api/wowlet-os/:id/file/:idx', requireAdmin, (req, res) => {
    const job = jobs.get(req.params.id);
    const it = job?.itens.find((x) => x.idx === Number(req.params.idx));
    if (!it?.arquivo || !fs.existsSync(it.arquivo)) return res.status(404).json({ error: 'Arquivo indisponível.' });
    res.setHeader('Content-Type', 'application/pdf');
    fs.createReadStream(it.arquivo).pipe(res);
  });

  app.post('/api/wowlet-os/:id/cancel', requireAdmin, (req, res) => {
    const job = jobs.get(req.params.id);
    if (job) job.cancelado = true;
    res.json({ ok: true });
  });
};
