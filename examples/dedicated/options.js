// The sample's options from its query string. No DOM, so a test can read it.
//
// Honoured ONLY when the page is served from localhost or 127.0.0.1: a page
// anywhere else always uses the defaults, so a link cannot point a deployed
// copy at another host, sign-in page or embedding parent.
//   ?host=        where the host is served          (default https://valuguru.texpo.io)
//   ?hostPath=    where on it the host page is      (default /host/; / for api.valuguru.app)
//   ?signin=      the Valu brand users sign in on   (default https://live.valuverse.io)
//   ?app=         the app's address, <workspace>/<slug>; a dev host serves a localhost
//                 page under it, a production host ignores it
//   ?hostOrigins= embedded only: the origins of the Valu Social that frames the page,
//                 comma-separated (a local one: http://localhost:3007); default the
//                 Valu origins the host trusts for sign-in

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1'];

/**
 * @param {{hostname: string, search: string}} where `location`, or the parts of it that matter.
 * @returns {object} What to pass to `createValuApp`, beyond the defaults.
 */
export function sampleOptions({ hostname, search }) {
  const options = {};
  if (!LOCAL_HOSTNAMES.includes(hostname)) return options;
  const query = new URLSearchParams(search);
  if (query.get('host')) options.hostOrigin = query.get('host');
  if (query.get('hostPath')) options.hostPath = query.get('hostPath');
  if (query.get('signin')) options.signInOrigin = query.get('signin');
  if (query.get('app')) options.app = query.get('app');
  const hostOrigins = (query.get('hostOrigins') ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (hostOrigins.length > 0) options.hostOrigins = hostOrigins;
  return options;
}
