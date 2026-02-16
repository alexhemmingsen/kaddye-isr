import { withQlara } from 'qlara/next';
import { aws } from 'qlara/aws';

export default withQlara({
  routeFile: './qlara.routes.ts',
  provider: aws(),
  env: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
})({
  output: 'export'
});
