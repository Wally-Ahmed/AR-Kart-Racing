/**
 * Adapter construction, shared by both pages (`src/main.ts` — director, `src/pilot/main.ts` —
 * phone pilot) so the `?adapter=` flag means exactly the same thing on each.
 *
 * Factored out rather than duplicated: the pilot page needs the identical mock / http / sdk / auto
 * choice, and a second copy of this switch is a second place for a venue-time URL flag to not work.
 */

import { type AdapterConfig, type DirectorAdapter } from './adapter.ts';
import { AutoAdapter } from './auto.ts';
import { HttpAdapter } from './http.ts';
import { MockAdapter } from './mock.ts';
import { SdkAdapter } from './sdk.ts';

export function makeAdapter(
  choice: 'mock' | 'http' | 'sdk' | null,
  config: AdapterConfig,
): DirectorAdapter {
  switch (choice) {
    case 'mock':
      return new MockAdapter(config);
    case 'http':
      return new HttpAdapter(config);
    case 'sdk':
      return new SdkAdapter(config);
    default:
      return new AutoAdapter(config);
  }
}
