'use client';

import { useEffect, useState } from 'react';
import { supabase, type Product } from '../../../lib/supabase';

export function ProductDetail({ id }: { id: string }) {
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('products')
      .select('*')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        if (data) {
          setProduct(data);
          // Update document title for SEO (captured by Clara's renderer)
          document.title = `${data.name} | Food Store`;
        }
        setLoading(false);
      });
  }, [id]);

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
