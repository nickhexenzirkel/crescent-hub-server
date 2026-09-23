// Reprocessa payloads de backfill de histórico (Coexistence) que já estão
// salvos em uniko_security_webhook_raw mas foram recebidos ANTES do fix que
// ensinou o código a entender o formato `value.history[].threads[]` — sem
// isso, essas mensagens antigas (e as SUAS, via history_context.from_me)
// nunca apareceriam, e a Meta não reenvia webhook que já recebeu 200.
//
// Rodar UMA VEZ na VPS, na pasta do crescent-hub-server:
//   node replay-history-backfill.js
//
// Idempotente: insertMessage já faz upsert por wa_message_id, então rodar
// de novo por engano não duplica nada.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { processHistoryBackfill } = require('./whatsappCloudApi');

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

  let found = 0, done = 0;
  for (const row of rows || []) {
    for (const entry of row.payload?.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (!Array.isArray(value.history)) continue;
        found++;
        try {
          await processHistoryBackfill(value);
          done++;
          console.log(`✅ raw id=${row.id} reprocessado`);
        } catch (e) {
          console.error(`❌ raw id=${row.id} falhou:`, e.message);
        }
      }
    }
  }
  console.log(`\nFim: ${done}/${found} payloads de backfill reprocessados.`);
  process.exit(0);
})();
