'use client';

import { useEffect, useState } from 'react';
import { supabase, type Product } from '../lib/supabase';

export function ProductList() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('products')
      .select('*')
      .order('id')
      .then(({ data }) => {
        setProducts(data || []);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h1>Products</h1>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {products.map((product) => (
          <li key={product.id} style={{ marginBottom: '1rem' }}>
            <a
              href={`/product/${product.id}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div
                style={{
                  padding: '1rem',
                  border: '1px solid #eee',
                  borderRadius: '8px',
                }}
              >
                <h2>{product.name}</h2>
                <p>${product.price.toFixed(2)}</p>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
