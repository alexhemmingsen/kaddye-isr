import type { QlaraRoutes } from 'qlara';
import { getProduct } from './lib/supabase';

const routes: QlaraRoutes = [
  {
    route: '/product/:id',
    metaDataGenerator: async (params) => {
      const product = await getProduct(params.id);
      if (!product) return null;

      return {
        title: `${product.name} | Food Store`,
        description: product.description,
        openGraph: {
          title: product.name,
          description: product.description,
          images: [{ url: product.image_url, alt: product.name }],
        },
      };
    },
  },
];

export default routes;
