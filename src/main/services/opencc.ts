// Traditional → simplified conversion (opencc-js, pure JS dictionaries, loaded lazily).
import * as OpenCC from 'opencc-js';

type Variant = 'tw' | 'hk' | 't';
const cache = new Map<Variant, (s: string) => string>();

export function toSimplified(text: string, variant: Variant = 't'): string {
  let fn = cache.get(variant);
  if (!fn) {
    fn = OpenCC.Converter({ from: variant === 'tw' ? 'twp' : variant, to: 'cn' });
    cache.set(variant, fn);
  }
  return fn(text);
}
