import type { ClaraRoutes } from 'clara';
import { getProduct } from './lib/supabase';

const routes: ClaraRoutes = [
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
        },
      };
    },
  },
];

export default routes;
