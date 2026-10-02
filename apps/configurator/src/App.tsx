import en from './locales/en.json';

export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4 py-16">
      <h1 className="text-3xl font-bold text-primary-deep">{en.productName}</h1>
      <p className="text-lg">{en.tagline}</p>
      <p className="rounded-md border border-line bg-primary-tint px-4 py-3 text-ink">
        {en.privacyLine}
      </p>
      <p className="text-ink-secondary">{en.comingSoon}</p>
    </main>
  );
}
