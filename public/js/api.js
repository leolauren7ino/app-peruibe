let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* resposta sem corpo */ }
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login' && url !== '/api/session') onUnauthorized();
    throw new Error(data.error || `Erro ${res.status}`);
  }
  return data;
}

export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const patch = (u, b) => api('PATCH', u, b);
export const del = (u) => api('DELETE', u);
