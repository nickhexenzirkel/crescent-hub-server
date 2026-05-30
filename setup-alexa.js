// ══════════════════════════════════════════════════
// SETUP ALEXA — rode localmente para gerar o token
// Comando: node setup-alexa.js
// ══════════════════════════════════════════════════

const AlexaRemote = require('alexa-remote2');
const alexa = new AlexaRemote();

const PORT = 3456;

console.log('\n🔧 Iniciando proxy de login da Amazon...');
console.log(`\n👉 Abra no navegador: http://localhost:${PORT}`);
console.log('   Faça login com sua conta Amazon normalmente.');
console.log('   Se pedir 2FA ou CAPTCHA, conclua pelo browser.\n');

alexa.init({
  proxyOnly:     true,
  proxyPort:     PORT,
  proxyLogLevel: 'warn',
}, (err, data) => {
  if (err) {
    console.error('\n❌ Erro:', err.message || err);
    process.exit(1);
  }

  const regData = JSON.stringify(data.formerRegistrationData || data);

  console.log('\n✅ Login realizado com sucesso!\n');
  console.log('══════════════════════════════════════════════════');
  console.log('Cole isso no Render como variável de ambiente:');
  console.log('  Nome:  ALEXA_REGISTRATION_DATA');
  console.log('  Valor: (copiado abaixo)\n');
  console.log(regData);
  console.log('══════════════════════════════════════════════════\n');

  process.exit(0);
});
