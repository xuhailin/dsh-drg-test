import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], {
  hostPhase: true,
  lib: { copy: [{ from: 'src/emr/definition.generated.d.ts', to: 'lib/types/emr' }] },
})
