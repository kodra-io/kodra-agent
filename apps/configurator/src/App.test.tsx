import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';
import { I18nProvider } from './i18n.tsx';
import ar from './locales/ar.json';
import en from './locales/en.json';

function renderApp() {
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/agent/');
});
afterEach(cleanup);

describe('App', () => {
  it('shows the title and the privacy line word for word', () => {
    renderApp();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Create your agent');
    expect(screen.getByTestId('privacy-line').textContent).toBe(
      'This page never asks for your keys. Your choices stay in your browser.',
    );
  });

  it('switches to Arabic and right-to-left', () => {
    renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Arabic' }));
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    expect(screen.getByTestId('privacy-line').textContent).toBe(ar['app.privacy']);
  });

  it('never renders a password field on any step', () => {
    renderApp();
    for (const step of ['Start', 'Model', 'Connectors', 'Review', 'Download']) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(step) }));
      expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    }
  });

  it('starts fresh and says so when the shared link is broken', () => {
    window.history.replaceState(null, '', '/agent/#v1.broken');
    renderApp();
    expect(screen.getByRole('status').textContent).toBe(en['app.invalidLink']);
  });
});

describe('locales', () => {
  it('Arabic has every English key and no empty strings', () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
    for (const value of Object.values(ar)) expect(value.trim()).not.toBe('');
  });

  it('uses no em dashes', () => {
    expect(JSON.stringify(en) + JSON.stringify(ar)).not.toContain('—');
  });
});
