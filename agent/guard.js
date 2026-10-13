// Trilhos de segurança do agente: o que ele pode LER e ESCREVER no repositório.
// A regra mais importante: nada de login, permissões, RH/ponto, segredos.
// (Espelha vault/Regras da IA.md — se mudar uma, mude a outra.)
const path = require('path');

// Onde o agente pode ESCREVER (caminhos relativos à raiz do repo, com "/").
const WRITE_ROOTS = ['src/modules/', 'src/shared/', 'src/components/', 'src/hooks/', 'vault/Sistema/'];
// Mesmo dentro das pastas acima, estes caminhos são proibidos.
const WRITE_DENY = [
  /(^|\/)(ponto|contracheque|desligamento|colaborador-info|prestacao)/i,   // RH / dados pessoais
  /(^|\/)dashboard-rh\/(contracheque|Gerenciar)/i,                          // pagamento e permissões do RH (o resto do painel — ordem das abas, visual — pode)
  /permiss|cargo|auth|login|senha|password|token|secret|jwt|credencia/i,    // segurança
  /(^|\/)uniko-(security|call|safer)\//i,                                   // conversas e ligações gravadas
];
// O que NÃO pode nem ser lido (segredos e lixo).
const READ_DENY = [/(^|\/)\.env/i, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /novo_token/i, /\.pem$/i, /(^|\/)dist(\/|$)/];
// Conteúdo que parece segredo: recusa gravar.
const SECRET_RE = /(eyJ[A-Za-z0-9_-]{25,}\.[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|dh_live_|gsk_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|service_role)/;

const MAX_FILES = 8;          // arquivos alterados por pedido
const MAX_CHANGED_LINES = 400;
const MAX_FILE_BYTES = 400 * 1024;

// Normaliza e valida um caminho vindo do modelo. Devolve { rel, abs } ou lança.
function resolveSafe(root, p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('caminho vazio');
  const rel = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (rel.split('/').includes('..')) throw new Error('caminho inválido (..)');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('caminho fora do projeto');
  return { rel, abs };
}
function assertReadable(rel) {
  if (READ_DENY.some(r => r.test(rel))) throw new Error(`leitura bloqueada: ${rel}`);
}
function assertWritable(rel) {
  if (!WRITE_ROOTS.some(r => rel.startsWith(r))) throw new Error(`escrita só é permitida em: ${WRITE_ROOTS.join(', ')} (tentou ${rel})`);
  if (WRITE_DENY.some(r => r.test(rel))) throw new Error(`este caminho é protegido (RH/segurança/conversas) e não pode ser alterado pelo agente: ${rel}`);
  assertReadable(rel);
}
function assertContent(text) {
  if (SECRET_RE.test(text)) throw new Error('conteúdo parece conter um segredo/chave — recusado');
}

module.exports = { WRITE_ROOTS, MAX_FILES, MAX_CHANGED_LINES, MAX_FILE_BYTES, resolveSafe, assertReadable, assertWritable, assertContent };
