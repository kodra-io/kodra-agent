import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { I18nProvider } from './i18n.tsx';
import { applyTheme, storedTheme } from './theme.ts';
import './index.css';

// Before the first paint, so the sign-in page is already in the saved theme.
applyTheme(storedTheme());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
);
