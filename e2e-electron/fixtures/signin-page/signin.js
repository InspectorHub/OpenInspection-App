const status = document.querySelector('#status');
const stateText = document.querySelector('#state');
let expectedState = null;

window.oiDesktop.auth.onCallback(async (raw) => {
  let callback;
  try { callback = new URL(raw); } catch { return; }
  if (callback.protocol !== 'io.inspectorhub.app:' || callback.host !== '' || callback.pathname !== '/oauth/callback') return;
  if (!expectedState || callback.searchParams.get('state') !== expectedState) return;
  const token = await fetch(`${window.authEngine}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: callback.searchParams.get('code'), state: expectedState }),
  }).then((response) => response.json());
  const session = await fetch(`${window.authEngine}/api/client/session`, {
    headers: { authorization: `Bearer ${token.access_token}` },
  }).then((response) => response.json());
  status.textContent = `Signed in: ${session.data.userId}`;
});

document.querySelector('#sign-in').addEventListener('click', async () => {
  expectedState = `state-${crypto.randomUUID()}`;
  stateText.textContent = expectedState;
  status.textContent = 'Waiting for sign-in';
  const registration = await fetch(`${window.authEngine}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uri: 'io.inspectorhub.app:/oauth/callback' }),
  }).then((response) => response.json());
  await fetch(`${window.authEngine}/api/client/compat?platform=windows`).then((response) => response.json());
  await window.oiDesktop.shell.openExternal(`${window.authEngine}/oauth/authorize?client_id=${registration.client_id}&state=${expectedState}`);
});

status.textContent = 'Ready';
