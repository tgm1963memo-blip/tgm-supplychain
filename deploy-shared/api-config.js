'use strict';

const DEFAULT_API_BASE = 'https://plates-extension-smtp-pop.trycloudflare.com';
function getApiBase(env = process.env) {
  const value = env.TGM_API_BASE_URL === undefined ? DEFAULT_API_BASE : env.TGM_API_BASE_URL;
  let url;
  try { url = new URL(value); } catch { throw new Error('TGM_API_BASE_URL must be an HTTPS origin'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || value.trim() !== value || /[<>"'\\]/.test(value)) {
    throw new Error('TGM_API_BASE_URL must be an HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin;
}
module.exports = { getApiBase, DEFAULT_API_BASE };
