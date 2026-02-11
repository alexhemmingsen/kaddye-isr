import type { Metadata } from 'next';

interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
}

// Mock product data — in a real app, this would come from an API
const products: Record<string, Product> = {
  '1': {
    id: '1',
    name: 'Organic Mango',
    description: 'Sweet and juicy organic mangoes from Mexico.',
    price: 3.99,
  },
  '2': {
    id: '2',
    name: 'Sourdough Bread',
    description: 'Freshly baked artisan sourdough bread.',
    price: 5.49,
  },
  '3': {
    id: '3',
    name: 'Greek Yogurt',
    description: 'Thick and creamy authentic Greek yogurt.',
    price: 4.29,
  },
};

// Pre-render these product pages at build time.
// New products added after the build are handled by Kaddye at runtime.
export async function generateStaticParams() {
  return Object.keys(products).map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const product = products[id];

  if (!product) {
    return { title: 'Product Not Found' };
  }

  return {
    title: `${product.name} | Food Store`,
    description: product.description,
    openGraph: {
      title: product.name,
      description: product.description,
    },
  };
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = products[id];

  if (!product) {
    return (
      <div>
        <h1>Product Not Found</h1>
        <p>The product you are looking for does not exist.</p>
        <a href="/">Back to products</a>
      </div>
    );
  }

  return (
    <div>
      <a href="/" style={{ color: '#666', textDecoration: 'none' }}>
        &larr; Back to products
      </a>
      <h1 style={{ marginTop: '1rem' }}>{product.name}</h1>
      <p style={{ color: '#666', fontSize: '1.1rem' }}>{product.description}</p>
      <p style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>
        ${product.price.toFixed(2)}
      </p>
    </div>
  );
}
