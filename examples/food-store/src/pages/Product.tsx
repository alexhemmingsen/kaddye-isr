import type { PageProps } from 'kaddye';

interface ProductData {
  id: string;
  name: string;
  price: number;
  description: string;
}

export function head(data: ProductData) {
  return (
    <>
      <title>{`${data.name} | Food Store`}</title>
      <meta name="description" content={data.description} />
    </>
  );
}

export default function Product({ data }: PageProps<ProductData>) {
  return (
    <div>
      <a href="/">&larr; Back to Home</a>
      <h1>{data.name}</h1>
      <p>{data.description}</p>
      <p>
        <strong>${data.price.toFixed(2)}</strong>
      </p>
    </div>
  );
}
