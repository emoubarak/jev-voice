// Second check before a navigation, in the browser's own URL parser: the address must be on the site the host
// approved (or found in your command). The host already refuses addresses Python and the browser could read
// differently; this catches any it might miss.
function sameSite(url, expect) {
  let got, want;
  try { got = new URL(url); want = new URL('https://' + expect + '/'); } catch (e) { return false; }
  return /^https?:$/.test(got.protocol) && !got.username && !got.password && got.hostname === want.hostname &&
    want.pathname === '/' && !want.username && want.port === '';
}
if (typeof module !== 'undefined') module.exports = {sameSite};
