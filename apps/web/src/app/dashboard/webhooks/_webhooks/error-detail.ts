import { ApiError } from '@/lib/api-client';

/**
 * What the API actually said, never replaced with a house message. A 422 that names the reason a
 * redelivery was refused is the whole answer; "something went wrong" is throwing it away.
 */
export function errorDetail(error: unknown): string {
  if (error instanceof ApiError) {
    return error.detail;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The request could not be completed.';
}
