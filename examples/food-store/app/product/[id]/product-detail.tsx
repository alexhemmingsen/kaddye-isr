'use client';

import { useEffect, useState } from 'react';
import { supabase, type Product } from '../../../lib/supabase';

export function ProductDetail({
  id,
  initial,
}: {
  id: string;
  initial: Product | null;
}) {
  const [product, setProduct] = useState<Product | null>(initial);
  const [loading, setLoading] = useState(!initial);

  useEffect(() => {
    // If we already have the product from build time, skip the fetch
    if (initial) return;

    // Runtime fetch — this runs when Puppeteer renders a new product page
    supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        setProduct(data);
        setLoading(false);
      });
  }, [id, initial]);

  if (loading) {
    return <div>Loading...</div>;
  }

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
