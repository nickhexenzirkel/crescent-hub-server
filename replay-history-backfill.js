// Reprocessa payloads antigos já salvos em uniko_security_webhook_raw que
// chegaram ANTES de algum fix no parser — a Meta não reenvia webhook que já
// recebeu 200, então esse é o único jeito de recuperar esse dado sem
// esperar um evento novo. Cobre 2 casos:
//  - backfill de histórico (`value.history[].threads[]`) — mensagens e
//    contatos antigos que nunca tinham sido entendidos.
//  - sincronização de contatos salvos (`value.state_sync[]`) — corrige
//    contato que ficou mostrando só o número em vez do nome salvo no
//    celular (fix de 23/set/2026).
//
// Rodar UMA VEZ na VPS, na pasta do crescent-hub-server:
//   node replay-history-backfill.js
//
// Idempotente: pode rodar de novo à vontade sem duplicar nada
// (insertMessage faz upsert por wa_message_id; processAppStateSync só
// atualiza contato que já existe).
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { processHistoryBackfill, processAppStateSync } = require('./whatsappCloudApi');

const supabase = createClient(
  process.env.UNIKO_SECURITY_SUPABASE_URL,
  process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY
);

(async () => {
  const { data: rows, error } = await supabase
    .from('uniko_security_webhook_raw')
    .select('id, payload')
    .order('id', { ascending: true });
  if (error) { console.error('Erro buscando payloads:', error.message); process.exit(1); }

  let foundHistory = 0, doneHistory = 0, foundSync = 0, doneSync = 0;
  for (const row of rows || []) {
    for (const entry of row.payload?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (Array.isArray(value.history)) {
          foundHistory++;
          try { await processHistoryBackfill(value); doneHistory++; console.log(`✅ histórico raw id=${row.id} reprocessado`); }
          catch (e) { console.error(`❌ histórico raw id=${row.id} falhou:`, e.message); }
        } else if (Array.isArray(value.state_sync)) {
          foundSync++;
          try { await processAppStateSync(value); doneSync++; console.log(`✅ contatos raw id=${row.id} reprocessado`); }
          catch (e) { console.error(`❌ contatos raw id=${row.id} falhou:`, e.message); }
        }
      }
    }
  }
  console.log(`\nFim: ${doneHistory}/${foundHistory} payloads de histórico + ${doneSync}/${foundSync} payloads de contatos reprocessados.`);
  process.exit(0);
})();
