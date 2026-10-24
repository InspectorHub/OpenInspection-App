import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { composeReal } from './app/compose';
import './styles.css';
import { followSystemColorScheme } from './ui/color-scheme';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

followSystemColorScheme(document.documentElement, window.matchMedia('(prefers-color-scheme: dark)'));

createRoot(root).render(
  <StrictMode>
    <App open={composeReal} />
  </StrictMode>,
);
