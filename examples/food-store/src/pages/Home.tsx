import type { PageProps } from 'kaddye';

interface Product {
  id: string;
  name: string;
  price: number;
  description: string;
}

interface HomeData {
  products: Product[];
}

export function head(_data: HomeData) {
  return (
    <>
      <title>Food Store - Home</title>
      <meta name="description" content="Browse our selection of fine foods." />
    </>
  );
}

export default function Home({ data }: PageProps<HomeData>) {
  return (
    <div>
      <h1>Welcome to the Food Store</h1>
      <ul>
        {data.products.map((product) => (
          <li key={product.id}>
            <a href={`/product/${product.id}`}>
              {product.name} - ${product.price.toFixed(2)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
