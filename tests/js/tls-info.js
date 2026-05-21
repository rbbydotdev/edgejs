const tls = require('tls');
const certs = tls.rootCertificates;
const ciphers = tls.getCiphers();
const looksLikeCert = typeof certs[0] === 'string' && certs[0].startsWith('-----BEGIN CERTIFICATE-----');
const hasCommonCipher = ciphers.includes('aes256-sha') || ciphers.includes('aes-256-gcm-sha384');
console.log(certs.length > 100 && ciphers.length > 20 && looksLikeCert && hasCommonCipher ? 'tls-info-ok' : 'tls-info-bad');
