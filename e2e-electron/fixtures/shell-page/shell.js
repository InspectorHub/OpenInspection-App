document.querySelector('#origin').textContent = location.origin;
document.querySelector('#bridge').textContent = window.oiDesktop ? 'Connected · API v1' : 'Unavailable';
document.querySelector('#node').textContent = typeof require === 'undefined' && typeof process === 'undefined' ? 'Isolated' : 'Exposed';
document.querySelector('#status').textContent = 'Shell checks complete';
