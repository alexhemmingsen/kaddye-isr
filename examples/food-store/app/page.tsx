import type { Metadata } from 'next';
import { ProductList } from './product-list';

export const metadata: Metadata = {
  title: 'Products | Food Store',
  description: 'Browse our selection of products',
  openGraph: {
    title: 'Products | Food Store',
    description: 'Browse our selection of products',
  },
};

export default function Home() {
  return <ProductList />;
}
