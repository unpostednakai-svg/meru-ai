
/**
 * Cloudflare Pages Functions: Claude API プロキシ
 *
 * エンドポイント: POST /api/claude
 *
 * - Firebase ID Token を検証してログイン済みユーザーのみ許可
 * - Anthropic API にリクエストを転送（APIキーはPagesの環境変数から）
 * - CORSは同一オリジンなので不要
 *
 * 必要な環境変数（Cloudflare Pages → 設定 → 環境変数）：
 *   - ANTHROPIC_API_KEY: Anthropic APIキー（シークレット）
 *   - FIREBASE_PROJECT_ID: Firebaseプロジェクト ID（通常の環境変数）
 */

export async function onRequestPost({ request, env }) {
  // ---------- 認証 ----------
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return jsonError(401, 'ログインが必要です');
  }

  let userInfo;
  try {
    userInfo = await verifyFirebaseIdToken(token, env.FIREBASE_PROJECT_ID);
  } catch (err) {
    return jsonError(401, '認証トークンが無効です: ' + err.message);
  }

  // ---------- リクエスト検証 ----------
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, '不正なJSONです');
  }
  if (!body.messages || !Array.isArray(body.messages)) {
    return jsonError(400, 'messagesフィールドが必要です');
  }
  const totalSize = JSON.stringify(body.messages).length;
  if (totalSize > 100000) {
    return jsonError(413, 'リクエストが大きすぎます');
  }

  // ---------- Anthropic APIへ転送 ----------
  if (!env.ANTHROPIC_API_KEY) {
    return jsonError(500, 'ANTHROPIC_API_KEYが未設定です');
  }

  const anthropicBody = {
    model: body.model || 'claude-sonnet-4-20250514',
    max_tokens: Math.min(body.max_tokens || 2000, 4000),
    messages: body.messages,
    ...(body.system ? { system: body.system } : {}),
  };

  let apiResponse;
  try {
    apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
    });
  } catch (err) {
    return jsonError(502, 'Anthropic APIに接続できません: ' + err.message);
  }

  const respText = await apiResponse.text();
  return new Response(respText, {
    status: apiResponse.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// OPTIONSリクエストのCORS応答（同一オリジンなら不要だが念のため）
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============ Firebase ID Token検証 ============
const GOOGLE_PUBLIC_KEYS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let _keyCache = { keys: null, exp: 0 };

async function getGooglePublicKeys() {
  const now = Date.now();
  if (_keyCache.keys && _keyCache.exp > now) return _keyCache.keys;
  const resp = await fetch(GOOGLE_PUBLIC_KEYS_URL);
  const keys = await resp.json();
  const cc = resp.headers.get('Cache-Control') || '';
  const m = cc.match(/max-age=(\d+)/);
  const ttl = m ? parseInt(m[1]) * 1000 : 3600000;
  _keyCache = { keys, exp: now + ttl };
  return keys;
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function base64UrlToString(str) {
  return new TextDecoder().decode(base64UrlDecode(str));
}

async function importPublicKey(pem) {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const spki = extractSpkiFromX509(der);
  return await crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

function extractSpkiFromX509(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('Invalid X.509');
  i = skipLength(der, i);
  if (der[i++] !== 0x30) throw new Error('Invalid TBS');
  const tbsLen = readLength(der, i);
  i = tbsLen.next;
  if (der[i] === 0xa0) {
    i++;
    const vl = readLength(der, i); i = vl.next + vl.len;
  }
  i = skipTLV(der, i); // serial
  i = skipTLV(der, i); // signature
  i = skipTLV(der, i); // issuer
  i = skipTLV(der, i); // validity
  i = skipTLV(der, i); // subject
  if (der[i] !== 0x30) throw new Error('Expected SPKI');
  const spkiStart = i;
  const spkiLen = readLength(der, i + 1);
  const spkiEnd = spkiLen.next + spkiLen.len;
  return der.slice(spkiStart, spkiEnd);
}

function readLength(der, i) {
  let b = der[i++];
  if (b < 0x80) return { len: b, next: i };
  const n = b & 0x7f;
  let len = 0;
  for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
  return { len, next: i };
}
function skipLength(der, i) { return readLength(der, i).next; }
function skipTLV(der, i) { i++; const r = readLength(der, i); return r.next + r.len; }

async function verifyFirebaseIdToken(token, projectId) {
  if (!projectId) throw new Error('FIREBASE_PROJECT_IDが未設定');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('JWT形式ではありません');

  const header = JSON.parse(base64UrlToString(parts[0]));
  const payload = JSON.parse(base64UrlToString(parts[1]));

  const keys = await getGooglePublicKeys();
  const pem = keys[header.kid];
  if (!pem) throw new Error('kidに対応する公開鍵が見つかりません');

  const publicKey = await importPublicKey(pem);
  const signingInput = parts[0] + '.' + parts[1];
  const signature = base64UrlDecode(parts[2]);
  const ok = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    signature,
    new TextEncoder().encode(signingInput)
  );
  if (!ok) throw new Error('署名が無効です');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('トークンの有効期限が切れています');
  if (payload.iat > now + 60) throw new Error('トークンの発行時刻が未来です');
  if (payload.aud !== projectId) throw new Error('aud不一致');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('iss不一致');
  }
  if (!payload.sub) throw new Error('subが空です');

  return { uid: payload.sub, email: payload.email, name: payload.name };
}

