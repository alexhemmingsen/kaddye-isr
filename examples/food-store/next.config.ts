import { withClara } from 'clara/next';
import { aws } from 'clara/aws';

export default withClara({
  routeFile: './clara.routes.ts',
  provider: aws()
})({
  output: 'export'
});
