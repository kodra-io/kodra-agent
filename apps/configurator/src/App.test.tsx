import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.tsx';

afterEach(cleanup);

describe('App', () => {
  it('shows the product name as the page heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Kodra AI Agent');
  });

  it('shows the privacy line word for word', () => {
    render(<App />);
    expect(
      screen.getByText('This page never asks for your keys. Your choices stay in your browser.'),
    ).toBeTruthy();
  });

  it('has no input fields of any kind', () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll('input, textarea, select')).toHaveLength(0);
  });
});
