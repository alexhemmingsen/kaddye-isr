const products = [
  { id: '1', name: 'Organic Mango', price: 3.99 },
  { id: '2', name: 'Sourdough Bread', price: 5.49 },
  { id: '3', name: 'Greek Yogurt', price: 4.29 },
];

export default function Home() {
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
