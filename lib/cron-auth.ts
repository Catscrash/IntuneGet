import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Cron route authentication
 *
 * The cron routes are ordinary HTTP routes that anyone can reach; the shared
 * secret in `CRON_SECRET` is all that separates a scheduler call from an
 * anonymous one. Comparing the header against `Bearer ${process.env.CRON_SECRET}`
 * directly fails open: with the variable unset the expected value is the
 * literal string "Bearer undefined", which any caller can send. This gate
 * therefore rejects every request while the secret is unconfigured.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return false;
  }

  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    return false;
  }

  // Digests give timingSafeEqual() the equal-length inputs it requires, so a
  // wrong secret cannot be narrowed down by its length or by how far it matched
  const provided = createHash('sha256').update(authHeader).digest();
  const expected = createHash('sha256').update(`Bearer ${cronSecret}`).digest();
  return timingSafeEqual(provided, expected);
}
