// ===========================================================================
// Networks — 1 function, channel `roomful`.
//
// The id is a fact of the connection; only the human-readable NAME needs a
// call. The app reads it from two different places depending on which screen
// asked (`data.fullName` in NetworksService, `data.network.fullName` in the
// TextChat provider), so both are read here and a missing name is `null`
// rather than an error — the id alone is still the answer to most of the
// question.
// ===========================================================================
import { ok, raw, isAckError, ackErrorMessage } from './support.js';

export function register(registry) {
  registry.define('Networks.get-current-network', async (params, ctx) => {
    const networkId = ctx.socket.networkId ?? '';
    const ack = await raw(ctx, 'network:getNetworkInfoForUser', { networkId });
    if (isAckError(ack)) {
      // Best-effort: the id is known regardless, so this is a partial answer,
      // not a failure. The caller is told the name is missing and why.
      return ok({ networkId, name: null, warning: ackErrorMessage(ack, 'could not resolve the network name') });
    }
    const data = ack.data ?? {};
    return ok({ networkId, name: data.fullName ?? data.network?.fullName ?? null });
  });
  return registry;
}
