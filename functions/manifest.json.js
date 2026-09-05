// Dynamic PWA manifest.
//
// iOS gives a home-screen web app its own storage partition, so nothing
// Pholia saved while running in Safari (server, username, token) is there
// when the installed app first launches — the user lands on a blank login
// form and, if they arrived via the ABS_shim hand-off, they have never typed
// a server address in their life. The one thing that DOES cross into the
// installed app is the manifest's start_url, so we bake the current server
// and username into it. The page tells us what they are two ways, because
// it isn't documented which one Safari honours at "Add to Home Screen"
// time: `?s=&u=` on the <link rel="manifest"> href (rewritten by
// ABS.saveCredentials) and the `pholia_install` cookie (same payload, sent
// with the same-origin manifest fetch). Query wins. No hint → the static
// manifest unchanged.
//
// The token itself is deliberately NOT put in start_url: it would sit in a
// launch URL forever and can't be rotated. Password-less sign-in in the
// installed app is the passkey's job (App._maybeOfferSaveToAccount).

function readHint(url, request) {
    let s = url.searchParams.get('s') || '';
    let u = url.searchParams.get('u') || '';
    if (!s) {
        const cookie = request.headers.get('Cookie') || '';
        const m = cookie.match(/(?:^|;\s*)pholia_install=([^;]+)/);
        if (m) {
            try {
                const parsed = JSON.parse(decodeURIComponent(m[1]));
                s = String(parsed.s || '');
                u = String(parsed.u || '');
            } catch { /* malformed cookie → no hint */ }
        }
    }
    // Only ever echo an http(s) origin+path of sane length back into a URL.
    let server = '';
    try {
        const parsed = new URL(s);
        if (/^https?:$/.test(parsed.protocol) && s.length <= 300) {
            server = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
        }
    } catch { /* not a URL */ }
    return { server, user: u.slice(0, 100) };
}

export async function onRequestGet({ request, env }) {
    const url = new URL(request.url);
    const base = await env.ASSETS.fetch(new Request(new URL('/manifest.json', url.origin).toString()));
    const manifest = await base.json();
    const hint = readHint(url, request);
    if (hint.server) {
        const qs = new URLSearchParams({ server: hint.server });
        if (hint.user) qs.set('u', hint.user);
        manifest.start_url = '/?' + qs.toString();
    }
    return new Response(JSON.stringify(manifest), {
        headers: {
            'Content-Type': 'application/manifest+json',
            // Per-user content — never let the edge or the browser share it.
            'Cache-Control': 'private, no-store',
        },
    });
}
