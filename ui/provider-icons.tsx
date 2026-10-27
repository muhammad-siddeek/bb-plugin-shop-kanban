/**
 * bb's omp mark (provider-acp/icons/omp.svg). bb only draws it for its shipped omp agent; a
 * provider-acp `customAgents` entry with id `omp` replaces that agent under the same provider id
 * and gets a generic glyph. Drawn in currentColor so it follows the surrounding text color.
 */
export function OmpIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor" className={className} aria-hidden>
      <path d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
    </svg>
  );
}
