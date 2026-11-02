// Switches the fake engine off or on through its control server (e2e/fake-engine/control.ts). The control server is on its OWN loopback
// port, so switching the engine off does not cut this call off. CONTROL_URL and UNAVAILABLE ("true" or "false") come in as flow env.
var response = http.post(CONTROL_URL + '/__test__/unavailable', {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ value: UNAVAILABLE === 'true' }),
});
if (!response.ok) {
  throw new Error('the control server answered ' + response.status + ' to /__test__/unavailable');
}
