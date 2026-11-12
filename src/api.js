// Browser side. It only ever receives the finished, signed link from the server.

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const api = {
  me: () => request('/api/me'),
  signup: (email, password, ageConfirmed) => request('/api/signup', { method: 'POST', body: { email, password, ageConfirmed } }),
  login: (email, password) => request('/api/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/api/logout', { method: 'POST', body: {} }),
  offerwallLink: () => request('/api/offerwall-link'),
};

/** Opens the offerwall in the embed.js pop-up, or as a normal page if the script has not loaded. */
export function openOfferwall(url) {
  if (window.Moonetix?.open) window.Moonetix.open(url);
  else window.location.href = url;
}
