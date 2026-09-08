import { redirect } from 'next/navigation';

import { readSession } from '@/lib/session';

/** A merchant with a session goes straight to their payments; anyone else is asked for a key. */
export default async function RootPage() {
  const session = await readSession();
  redirect(session === null ? '/connect' : '/dashboard');
}
