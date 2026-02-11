import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Food Store',
  description: 'A demo food store powered by Kaddye',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <nav style={{ padding: '1rem', borderBottom: '1px solid #eee' }}>
          <a href="/" style={{ fontWeight: 'bold', fontSize: '1.2rem' }}>
            Food Store
          </a>
        </nav>
        <main style={{ padding: '2rem', maxWidth: '800px', margin: '0 auto' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
