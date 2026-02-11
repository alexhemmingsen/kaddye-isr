import { withKaddye } from 'kaddye/next';
import { aws } from 'kaddye/aws';

export default withKaddye({
  routes: [{ pattern: '/product/:id' }],
  provider: aws({ region: 'eu-west-1' }),
})({
  output: 'export',
});
