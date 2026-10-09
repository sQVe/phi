import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { AttachSession } from '../client/client.ts';

export const StatusBar = ({ session }: { session: AttachSession }): ReactNode => {
  const state = useSyncExternalStore(session.subscribe, session.getState);

  return (
    <text height={1} flexShrink={0}>
      {state.inputMode}
    </text>
  );
};
