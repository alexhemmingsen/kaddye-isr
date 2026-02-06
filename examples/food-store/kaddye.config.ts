import { defineConfig } from 'kaddye';

const products = [
  {
    id: '1',
    name: 'Organic Mango',
    price: 4.99,
    description: 'Sweet and juicy organic mango from Brazil.',
  },
  {
    id: '2',
    name: 'Sourdough Bread',
    price: 6.5,
    description: 'Artisan sourdough bread, freshly baked.',
  },
  {
    id: '3',
    name: 'Aged Cheddar',
    price: 8.99,
    description: 'Sharp aged cheddar cheese, 12 months matured.',
  },
];

export default defineConfig({
  routes: [
    {
      path: '/product/:id',
      component: './src/pages/Product.tsx',
      staticParams: async () => products.map((p) => ({ id: p.id })),
      data: async (params) => {
        const product = products.find((p) => p.id === params.id);
        if (!product) return null;
        return product;
      },
    },
  ],
});
