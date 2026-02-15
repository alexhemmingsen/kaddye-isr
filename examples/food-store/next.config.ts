import { withClara } from 'clara/next';
import { aws } from 'clara/aws';

export default withClara({
  routeFile: './clara.routes.ts',
  provider: aws(),
  env: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
})({
  output: 'export'
});
