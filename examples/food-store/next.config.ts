import { withClara } from 'clara/next';
import { aws } from 'clara/aws';

export default withClara({
  routes: [{ pattern: '/product/:id' }],
  provider: aws()
})({
  output: 'export'
});
