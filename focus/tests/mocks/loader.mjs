// Node module hook: point the edge function's npm: imports at the local mocks.
const MAP = {
  'npm:@supabase/supabase-js@2': new URL('./supabase.mjs', import.meta.url).href,
  'npm:@pushforge/builder@2.0.4': new URL('./pushforge.mjs', import.meta.url).href,
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: MAP[specifier], shortCircuit: true };
  return next(specifier, context);
}
