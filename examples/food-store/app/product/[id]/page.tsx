import type { Metadata } from 'next';
import { getProducts, getProduct } from '../../../lib/supabase';
import { ProductDetail } from './product-detail';

// Pre-render product pages for all products known at build time.
// New products added to Supabase after the build are handled by Clara at runtime.
export async function generateStaticParams() {
  const products = await getProducts();
  return products.map((p) => ({ id: p.id }));
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  const product = await getProduct(id);

  if (!product) {
    return { title: 'Product Not Found' };
  }

  return {
    title: `${product.name} | Food Store`,
    description: product.description,
    openGraph: {
      title: product.name,
      description: product.description,
      images: [{ url: product.image_url, alt: product.name }]
    }
  };
}

export default async function ProductPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ProductDetail id={id} />;
}
